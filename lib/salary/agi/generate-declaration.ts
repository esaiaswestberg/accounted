/**
 * Shared AGI XML generation + persistence orchestration.
 *
 * Both the internal dashboard route (`GET /api/salary/runs/{id}/agi/xml`)
 * and the v1 public route (`POST /api/v1/companies/{companyId}/salary-runs/{id}/generate-agi`)
 * call this helper. It loads the salary run + employees + per-day absence
 * records, builds the Skatteverket AGI XML, upserts the agi_declarations
 * row (correction-aware), updates `salary_runs.agi_generated_at`, emits
 * `agi.generated`, and auto-completes the `arbetsgivardeklaration` deadline
 * for the period.
 *
 * Returns a discriminated result so callers can wrap it in their own
 * response envelope (internal uses raw `Response`; v1 uses the JSON `ok`
 * envelope with `xml` embedded as a string field).
 *
 * Per agi-filing.md:
 *   - FK570 (specifikationsnummer) MUST stay consistent per employee
 *   - Corrections resubmit with same FK570 — a different number = a new record
 *   - XML is räkenskapsinformation; stored for 7-year retention per BFL 7 kap
 *   - Filing deadline: the 12th of the following month (17th in Jan/Aug for
 *     companies ≤ 40 MSEK turnover)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  generateAGIXml,
  buildIndividuppgifterSnapshot,
  AGIIncompleteDataError,
} from './xml-generator'
import type { AGIEmployeeData, AGICompanyData, AGITotals } from './xml-generator'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'

const ELIGIBLE_STATUSES = ['review', 'approved', 'paid', 'booked', 'corrected'] as const

export interface GenerateAgiDeclarationArgs {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** Falls back into AGI contactEmail when company_settings + profile both have none. */
  userEmail: string | null
  salaryRunId: string
  log: Logger
  requestId: string
}

export type GenerateAgiDeclarationResult =
  | {
      ok: true
      xml: string
      agiDeclarationId: string
      periodYear: number
      periodMonth: number
      employeeCount: number
      isCorrection: boolean
      totals: AGITotals
      orgNumber: string
    }
  | {
      ok: false
      code: string
      details?: unknown
      status?: number
    }

function sumLineItemAmounts(
  lineItems: Array<Record<string, unknown>>,
  types: string[],
): number {
  return lineItems
    .filter((li) => types.includes(li.item_type as string))
    .reduce((sum, li) => sum + ((li.amount as number) || 0), 0)
}

export async function generateAgiDeclaration(
  args: GenerateAgiDeclarationArgs,
): Promise<GenerateAgiDeclarationResult> {
  const { supabase, companyId, userId, userEmail, salaryRunId, log, requestId } = args
  const opLog = log.child({ salaryRunId })

  // 1. Run + status precheck.
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) {
    return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  }
  if (!ELIGIBLE_STATUSES.includes((run.status as typeof ELIGIBLE_STATUSES[number]))) {
    return {
      ok: false,
      code: 'AGI_GENERATE_NOT_BOOKABLE',
      details: { current_status: run.status, eligible_statuses: ELIGIBLE_STATUSES },
    }
  }

  // 2. Company + settings + profile (for contact info).
  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()

  if (!company) {
    return { ok: false, code: 'COMPANY_NOT_FOUND' }
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('org_number, phone, email')
    .eq('company_id', companyId)
    .single()

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', userId)
    .single()

  // 3. Roster + line items + per-day absence.
  const { data: runEmployees } = await supabase
    .from('salary_run_employees')
    .select(
      '*, employee:employees(personnummer, specification_number, f_skatt_status, monthly_salary), line_items:salary_line_items(*)',
    )
    .eq('salary_run_id', salaryRunId)

  if (!runEmployees || runEmployees.length === 0) {
    return { ok: false, code: 'SALARY_RUN_NO_EMPLOYEES' }
  }

  // 4. Build AGI input shapes.
  const companyData: AGICompanyData = {
    orgNumber: (settings?.org_number || company.org_number || '').trim(),
    companyName: company.name,
    periodYear: run.period_year,
    periodMonth: run.period_month,
    contactName: (profile?.full_name || company.name || '').trim(),
    contactPhone: (settings?.phone || '').trim(),
    contactEmail: (settings?.email || profile?.email || userEmail || '').trim(),
  }

  // Load per-day absence (VAB + parental only — sick days go to FK separately).
  const periodStart = `${run.period_year}-${String(run.period_month).padStart(2, '0')}-01`
  const periodEndDate = new Date(Date.UTC(run.period_year, run.period_month, 0))
  const periodEnd = periodEndDate.toISOString().slice(0, 10)
  const employeeIds = (runEmployees as Array<{ employee_id: string }>)
    .map((sre) => sre.employee_id)
    .filter(Boolean)

  const absenceByEmployee = new Map<
    string,
    Array<{ date: string; type: 'vab' | 'parental'; hours: number }>
  >()
  if (employeeIds.length > 0) {
    const { data: absenceRows } = await supabase
      .from('salary_absence_days')
      .select('employee_id, absence_date, absence_type, hours')
      .eq('company_id', companyId)
      .in('absence_type', ['vab', 'parental'])
      .gte('absence_date', periodStart)
      .lte('absence_date', periodEnd)
      .in('employee_id', employeeIds)
    for (const row of (absenceRows ?? []) as Array<{
      employee_id: string
      absence_date: string
      absence_type: 'vab' | 'parental'
      hours: number
    }>) {
      const list = absenceByEmployee.get(row.employee_id) ?? []
      list.push({
        date: row.absence_date,
        type: row.absence_type,
        hours: Number(row.hours ?? 8),
      })
      absenceByEmployee.set(row.employee_id, list)
    }
  }

  const employeeData: AGIEmployeeData[] = (runEmployees as Array<Record<string, unknown>>).map(
    (sre) => {
      const emp = sre.employee as {
        personnummer: string
        specification_number: number
        f_skatt_status: string
      } | null
      const lineItems = (sre.line_items || []) as Array<Record<string, unknown>>

      const benefitCar = sumLineItemAmounts(lineItems, ['benefit_car'])
      const benefitMeals = sumLineItemAmounts(lineItems, ['benefit_meals'])
      const benefitHousing = sumLineItemAmounts(lineItems, ['benefit_housing'])
      const benefitOther = sumLineItemAmounts(lineItems, ['benefit_wellness', 'benefit_other'])
      const absenceEvents = absenceByEmployee.get(sre.employee_id as string)

      return {
        personnummer: emp?.personnummer || '',
        specificationNumber: emp?.specification_number || 0,
        grossSalary: sre.gross_salary as number,
        taxWithheld: sre.tax_withheld as number,
        avgifterBasis: sre.avgifter_basis as number,
        fSkattPayment:
          emp?.f_skatt_status === 'f_skatt' ? (sre.gross_salary as number) : undefined,
        benefitCar: benefitCar > 0 ? benefitCar : undefined,
        benefitHousing: benefitHousing > 0 ? benefitHousing : undefined,
        benefitMeals: benefitMeals > 0 ? benefitMeals : undefined,
        benefitOther: benefitOther > 0 ? benefitOther : undefined,
        sickDays: (sre.sick_days as number) > 0 ? (sre.sick_days as number) : undefined,
        vabDays: (sre.vab_days as number) > 0 ? (sre.vab_days as number) : undefined,
        parentalDays:
          (sre.parental_days as number) > 0 ? (sre.parental_days as number) : undefined,
        absenceEvents: absenceEvents && absenceEvents.length > 0 ? absenceEvents : undefined,
      }
    },
  )

  // 5. Build totals: avgifter by category (with rate-heuristic fallback for legacy runs).
  const avgifterByCategory: AGITotals['avgifterByCategory'] = {}
  for (const sre of runEmployees as Array<Record<string, unknown>>) {
    const dbCategory = sre.avgifter_category as string | null
    const category = dbCategory
      ? dbCategory === 'reduced_65plus'
        ? 'reduced65plus'
        : dbCategory === 'vaxa_stod'
          ? 'standard'
          : dbCategory
      : (sre.avgifter_rate as number) <= 0.1022
        ? 'reduced65plus'
        : (sre.avgifter_rate as number) <= 0.2082
          ? 'youth'
          : 'standard'
    const cat = (avgifterByCategory as Record<string, { basis: number; amount: number }>)[
      category
    ] || { basis: 0, amount: 0 }
    cat.basis += sre.avgifter_basis as number
    cat.amount += sre.avgifter_amount as number
    ;(avgifterByCategory as Record<string, { basis: number; amount: number }>)[category] = cat
  }
  const totalAvgifterAmount = Object.values(avgifterByCategory).reduce(
    (sum, cat) => sum + (cat?.amount ?? 0),
    0,
  )

  // FK499 sjuklönekostnad — sum of paid sjuklön (days 2-14) across all
  // employees. Day 1 is karens (unpaid); day 15+ is Försäkringskassan.
  const calcParams = ((run.calculation_params as Record<string, unknown>) ?? {}) as {
    sjuklonRate?: number
    sjuklon_rate?: number
  }
  const sjuklonRate = calcParams.sjuklonRate ?? calcParams.sjuklon_rate ?? 0.8
  let totalSjuklonekostnad = 0
  for (const sre of runEmployees as Array<Record<string, unknown>>) {
    const monthly =
      ((sre.employee as { monthly_salary?: number } | null)?.monthly_salary as number) ?? 0
    if (!monthly) continue
    const dailyRate = monthly / 21
    const lineItems = (sre.line_items || []) as Array<Record<string, unknown>>
    for (const li of lineItems) {
      if (li.item_type === 'sick_day2_14') {
        const days = (li.quantity as number) || 0
        totalSjuklonekostnad += dailyRate * sjuklonRate * days
      }
    }
  }

  const totals: AGITotals = {
    totalTax: run.total_tax,
    totalAvgifterBasis: (runEmployees as Array<{ avgifter_basis: number }>).reduce(
      (s, e) => s + e.avgifter_basis,
      0,
    ),
    totalAvgifterAmount: Math.round(totalAvgifterAmount * 100) / 100,
    totalSjuklonekostnad: Math.round(totalSjuklonekostnad * 100) / 100,
    avgifterByCategory,
  }

  // 6. Existing AGI determines correction status. Use `.maybeSingle()`
  // because the lookup must tolerate the no-row case without throwing —
  // that's the FIRST-time generation path. `.single()` would surface a
  // PGRST116 row-not-found error and abort what should be a clean insert.
  const { data: existingAgi } = await supabase
    .from('agi_declarations')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_year', run.period_year)
    .eq('period_month', run.period_month)
    .maybeSingle()

  const isCorrection = !!existingAgi

  // 7. Generate XML.
  let xml: string
  try {
    xml = generateAGIXml(companyData, employeeData, totals, isCorrection)
  } catch (err) {
    if (err instanceof AGIIncompleteDataError) {
      return {
        ok: false,
        code: 'AGI_INCOMPLETE_DATA',
        details: { missing_fields: err.missingFields, message: err.message },
      }
    }
    throw err
  }
  const individuppgifter = buildIndividuppgifterSnapshot(employeeData)

  // 8. UPSERT agi_declarations.
  let agiDeclarationId: string
  if (existingAgi) {
    const { error: updErr } = await supabase
      .from('agi_declarations')
      .update({
        xml_content: xml,
        individuppgifter,
        total_gross: run.total_gross,
        total_tax: run.total_tax,
        total_avgifter_basis: totals.totalAvgifterBasis,
        // Use the per-category sum that drives the XML rather than the
        // run-level denormalised total. Both should agree, but a
        // round-then-sum vs sum-then-round can produce öre drift; the
        // agi_declarations row should align with what was actually
        // serialised into the XML (which Skatteverket sees).
        total_avgifter: totals.totalAvgifterAmount,
        employee_count: employeeData.length,
        is_correction: true,
        salary_run_id: run.id,
      })
      .eq('id', existingAgi.id)
    if (updErr) {
      return { ok: false, code: 'DATABASE_ERROR', details: updErr }
    }
    agiDeclarationId = existingAgi.id as string
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('agi_declarations')
      .insert({
        company_id: companyId,
        user_id: userId,
        salary_run_id: run.id,
        period_year: run.period_year,
        period_month: run.period_month,
        xml_content: xml,
        individuppgifter,
        total_gross: run.total_gross,
        total_tax: run.total_tax,
        total_avgifter_basis: totals.totalAvgifterBasis,
        // Use the per-category sum that drives the XML rather than the
        // run-level denormalised total. Both should agree, but a
        // round-then-sum vs sum-then-round can produce öre drift; the
        // agi_declarations row should align with what was actually
        // serialised into the XML (which Skatteverket sees).
        total_avgifter: totals.totalAvgifterAmount,
        employee_count: employeeData.length,
      })
      .select('id')
      .single()

    if (insErr) {
      // Concurrent-call race: two :generate-agi requests for the same
      // (company, period) reached the INSERT branch simultaneously. The
      // earlier read of `existingAgi` returned null for both, but the
      // first INSERT wins and the second hits the unique constraint.
      // Postgres error 23505 is the unique-violation code; recover by
      // re-fetching the now-existing row and treating this call as a
      // correction (the second caller's XML supersedes the first).
      if ((insErr as { code?: string }).code === '23505') {
        const { data: nowExisting, error: refetchErr } = await supabase
          .from('agi_declarations')
          .select('id')
          .eq('company_id', companyId)
          .eq('period_year', run.period_year)
          .eq('period_month', run.period_month)
          .maybeSingle()
        if (refetchErr || !nowExisting) {
          return { ok: false, code: 'DATABASE_ERROR', details: refetchErr || insErr }
        }
        const { error: raceUpdErr } = await supabase
          .from('agi_declarations')
          .update({
            xml_content: xml,
            individuppgifter,
            total_gross: run.total_gross,
            total_tax: run.total_tax,
            total_avgifter_basis: totals.totalAvgifterBasis,
            // Use the per-category sum that drives the XML rather than the
        // run-level denormalised total. Both should agree, but a
        // round-then-sum vs sum-then-round can produce öre drift; the
        // agi_declarations row should align with what was actually
        // serialised into the XML (which Skatteverket sees).
        total_avgifter: totals.totalAvgifterAmount,
            employee_count: employeeData.length,
            is_correction: true,
            salary_run_id: run.id,
          })
          .eq('id', nowExisting.id)
        if (raceUpdErr) {
          return { ok: false, code: 'DATABASE_ERROR', details: raceUpdErr }
        }
        agiDeclarationId = nowExisting.id as string
        opLog.warn('agi_declarations insert raced; recovered via update', {
          companyId,
          periodYear: run.period_year,
          periodMonth: run.period_month,
        })
        // Note: the caller-facing `isCorrection` flag (set above based on
        // the pre-INSERT existingAgi lookup) reports `false` even though
        // the database state is now technically a correction. Edge case
        // limited to the race window; the agi_declarations row is
        // correctly marked is_correction=true and the next call will
        // see it.
      } else {
        return { ok: false, code: 'DATABASE_ERROR', details: insErr }
      }
    } else if (!inserted) {
      return { ok: false, code: 'DATABASE_ERROR', details: insErr }
    } else {
      agiDeclarationId = inserted.id as string
    }
  }

  // 9. Stamp generation timestamp on salary_runs.
  await supabase
    .from('salary_runs')
    .update({ agi_generated_at: new Date().toISOString() })
    .eq('id', salaryRunId)

  // 10. Emit agi.generated (best-effort — never block the success path).
  try {
    await eventBus.emit({
      type: 'agi.generated',
      payload: {
        agiId: agiDeclarationId,
        periodYear: run.period_year,
        periodMonth: run.period_month,
        userId,
        companyId,
      },
    })
  } catch (err) {
    opLog.warn('agi.generated emit failed', err as Error)
  }

  // 11. Auto-complete the arbetsgivardeklaration deadline for this period
  //     (Skatteförfarandelagen — AGI generation satisfies the filing
  //     obligation). Optimistic-lock on status='pending'.
  const period = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  await supabase
    .from('deadlines')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      completed_by: userId,
    })
    .eq('company_id', companyId)
    .eq('type', 'arbetsgivardeklaration')
    .eq('period', period)
    .eq('status', 'pending')

  opLog.info('AGI declaration generated', {
    requestId,
    salaryRunId,
    agiDeclarationId,
    isCorrection,
    employeeCount: employeeData.length,
  })

  return {
    ok: true,
    xml,
    agiDeclarationId,
    periodYear: run.period_year,
    periodMonth: run.period_month,
    employeeCount: employeeData.length,
    isCorrection,
    totals,
    orgNumber: companyData.orgNumber,
  }
}
