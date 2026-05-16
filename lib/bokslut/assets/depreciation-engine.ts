import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { listAssets } from './asset-service'
import type {
  Asset,
  FiscalPeriod,
  JournalEntry,
  CreateJournalEntryLineInput,
} from '@/types'

export interface AssetDepreciation {
  asset: Asset
  /** Planenlig avskrivning för denna period, avrundad till hela kronor. */
  amount: number
  /** Net book value vid periodens slut (ackumulerad avskrivning inklusive
   *  denna period subtraherat från anskaffningsvärdet). Används av wizard
   *  UI:t för att visa restvärde efter avskrivning. */
  netBookValueAfter: number
  /** True om avskrivningen pro-rateras (tillgång anskaffad eller fullt
   *  avskriven mitt i perioden). */
  proRated: boolean
  /** Befintligt depreciation_schedules-id om en proposal redan finns för
   *  denna kombination. Wizard:t använder detta för att veta att proposalen
   *  redan har bokförts (om journal_entry_id är satt) eller är väntande
   *  (om journal_entry_id är null). */
  existingScheduleId?: string
  existingJournalEntryId?: string | null
}

export interface DepreciationProposal {
  fiscalPeriod: { id: string; name: string; period_start: string; period_end: string }
  items: AssetDepreciation[]
  totalAmount: number
}

/**
 * Compute planenlig avskrivning för en enskild tillgång under en given
 * fiscal period. Pro-rateras vid första och sista året.
 *
 * Only the linear method is implemented. The API rejects asset creation /
 * updates with the other DB-enum values (declining_balance_*), so any asset
 * that reaches here has method='linear'; treating the other branches as
 * dead code is safe.
 */
export function computeAnnualDepreciation(
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
): { amount: number; proRated: boolean } {
  if (asset.disposed_at && asset.disposed_at < fiscalPeriod.period_start) {
    return { amount: 0, proRated: false }
  }

  const acquisitionCost = Number(asset.acquisition_cost)
  const salvageValue = Number(asset.salvage_value)
  const depreciableBase = acquisitionCost - salvageValue
  if (depreciableBase <= 0) return { amount: 0, proRated: false }

  const usefulLifeMonths = asset.useful_life_months
  const annualRate = 12 / usefulLifeMonths

  // Determine the depreciation window for this period: the overlap between
  // the asset's active life and the fiscal period.
  const acquisition = isoToDate(asset.acquisition_date)
  const lifeEndExclusive = addMonths(acquisition, usefulLifeMonths)
  const periodStart = isoToDate(fiscalPeriod.period_start)
  const periodEndInclusive = isoToDate(fiscalPeriod.period_end)
  const disposalEnd = asset.disposed_at ? isoToDate(asset.disposed_at) : null

  const windowStart = maxDate(acquisition, periodStart)
  let windowEnd = minDate(periodEndInclusive, addDays(lifeEndExclusive, -1))
  if (disposalEnd) windowEnd = minDate(windowEnd, disposalEnd)

  if (windowEnd < windowStart) return { amount: 0, proRated: false }

  const fullPeriodDays = daysBetween(periodStart, periodEndInclusive) + 1
  const windowDays = daysBetween(windowStart, windowEnd) + 1
  const fraction = windowDays / fullPeriodDays
  const proRated = fraction < 0.999

  // Full-year amount = annualRate × depreciableBase (linear).
  const annualAmount = depreciableBase * annualRate
  const proRatedAmount = annualAmount * fraction

  return {
    amount: Math.round(proRatedAmount),
    proRated,
  }
}

/**
 * Build a proposal listing planenlig avskrivning för every active asset.
 * Reads existing depreciation_schedules so already-posted entries aren't
 * proposed twice (the unique constraint on (asset_id, fiscal_period_id)
 * would reject duplicates anyway, but the UI wants to display "redan
 * bokförd" rather than fail).
 */
export async function proposeAnnualPostings(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<DepreciationProposal> {
  const [periodResult, assets, currentSchedulesResult, priorSchedulesResult] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    listAssets(supabase, companyId),
    // Schedules in the current period (proposal lookup / "already posted" badge)
    supabase
      .from('depreciation_schedules')
      .select('id, asset_id, journal_entry_id')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId),
    // Prior posted schedules (excluding the current period) so we can compute
    // the true accumulated depreciation per asset for net book value.
    supabase
      .from('depreciation_schedules')
      .select('asset_id, planned_depreciation, journal_entry_id, fiscal_period_id')
      .eq('company_id', companyId)
      .neq('fiscal_period_id', fiscalPeriodId)
      .not('journal_entry_id', 'is', null),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }
  const period = periodResult.data
  const existing = new Map<string, { id: string; journal_entry_id: string | null }>(
    (currentSchedulesResult.data ?? []).map(
      (r: { id: string; asset_id: string; journal_entry_id: string | null }) => [
        r.asset_id,
        { id: r.id, journal_entry_id: r.journal_entry_id },
      ],
    ),
  )

  // Sum of all prior posted depreciation per asset. This is the accumulated
  // depreciation on the books before this period — does not yet count this
  // period's proposal or any unposted current-period draft.
  const priorAccumulated = new Map<string, number>()
  for (const row of (priorSchedulesResult.data ?? []) as Array<{
    asset_id: string
    planned_depreciation: number | string
  }>) {
    const v = Number(row.planned_depreciation) || 0
    priorAccumulated.set(row.asset_id, (priorAccumulated.get(row.asset_id) ?? 0) + v)
  }

  const items: AssetDepreciation[] = []
  for (const asset of assets) {
    // Skip assets disposed before period start
    if (asset.disposed_at && asset.disposed_at < period.period_start) continue

    const { amount, proRated } = computeAnnualDepreciation(asset, period)
    if (amount <= 0) continue

    const existingSchedule = existing.get(asset.id)
    const accumulatedBefore = priorAccumulated.get(asset.id) ?? 0
    const netBookValueAfter =
      Math.round((Number(asset.acquisition_cost) - accumulatedBefore - amount) * 100) / 100

    items.push({
      asset,
      amount,
      netBookValueAfter,
      proRated,
      existingScheduleId: existingSchedule?.id,
      existingJournalEntryId: existingSchedule?.journal_entry_id ?? null,
    })
  }

  return {
    fiscalPeriod: period,
    items,
    totalAmount: items.reduce((sum, item) => sum + item.amount, 0),
  }
}

/**
 * Commit the proposal as journal entries. Creates ONE journal entry per
 * asset (rather than a single batch entry) so each can be reversed
 * independently and so the depreciation_schedules row links one-to-one to
 * its journal entry.
 *
 * Skips assets that already have a posted schedule för this period — the
 * unique constraint would block them, and silently skipping is more useful
 * than throwing. Returns the list of (asset_id, schedule, entry) tuples.
 */
export async function commitAnnualPostings(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  options: { assetIds?: string[] } = {},
): Promise<{
  posted: { assetId: string; entry: JournalEntry; scheduleId: string }[]
  skipped: { assetId: string; reason: string }[]
}> {
  const proposal = await proposeAnnualPostings(supabase, companyId, fiscalPeriodId)
  const periodEnd = proposal.fiscalPeriod.period_end
  const periodName = proposal.fiscalPeriod.name

  const allowed = options.assetIds ? new Set(options.assetIds) : null
  const posted: { assetId: string; entry: JournalEntry; scheduleId: string }[] = []
  const skipped: { assetId: string; reason: string }[] = []

  for (const item of proposal.items) {
    if (allowed && !allowed.has(item.asset.id)) continue
    if (item.existingJournalEntryId) {
      skipped.push({ assetId: item.asset.id, reason: 'already_posted' })
      continue
    }

    const lines: CreateJournalEntryLineInput[] = [
      {
        account_number: item.asset.bas_expense_account,
        debit_amount: item.amount,
        credit_amount: 0,
        line_description: `Avskrivning ${item.asset.name}`,
      },
      {
        account_number: item.asset.bas_accumulated_account,
        debit_amount: 0,
        credit_amount: item.amount,
        line_description: `Ack. avskrivning ${item.asset.name}`,
      },
    ]

    const entry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: fiscalPeriodId,
      entry_date: periodEnd,
      description: `Planenlig avskrivning ${periodName}: ${item.asset.name}`,
      source_type: 'year_end',
      voucher_series: 'A',
      lines,
    })

    // Upsert the schedule row. If a draft (no journal_entry_id) already
    // exists for (asset, period) we overwrite it with the posted entry.
    if (item.existingScheduleId) {
      const { error } = await supabase
        .from('depreciation_schedules')
        .update({ journal_entry_id: entry.id, posted_at: new Date().toISOString() })
        .eq('id', item.existingScheduleId)
        .eq('company_id', companyId)
      if (error) throw new Error(`Failed to update schedule: ${error.message}`)
      posted.push({ assetId: item.asset.id, entry, scheduleId: item.existingScheduleId })
    } else {
      const { data, error } = await supabase
        .from('depreciation_schedules')
        .insert({
          user_id: userId,
          company_id: companyId,
          asset_id: item.asset.id,
          fiscal_period_id: fiscalPeriodId,
          planned_depreciation: item.amount,
          journal_entry_id: entry.id,
          posted_at: new Date().toISOString(),
        })
        .select('id')
        .single()
      if (error || !data) throw new Error(`Failed to insert schedule: ${error?.message}`)
      posted.push({ assetId: item.asset.id, entry, scheduleId: data.id })
    }
  }

  return { posted, skipped }
}

// ============================================================
// Date helpers — keep pure so the unit tests don't need to mock anything.
// ============================================================

function isoToDate(iso: string): Date {
  // Force UTC midnight to avoid local-time DST drift confusing days math.
  return new Date(iso + 'T00:00:00Z')
}

function addMonths(date: Date, months: number): Date {
  // Clamp the day to the last valid day of the target month so end-of-month
  // dates don't overflow forward (Jan 31 + 1 month → Feb 28, not Mar 3).
  const targetMonth = date.getUTCMonth() + months
  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0),
  ).getUTCDate()
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      targetMonth,
      Math.min(date.getUTCDate(), lastDayOfTargetMonth),
    ),
  )
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}
