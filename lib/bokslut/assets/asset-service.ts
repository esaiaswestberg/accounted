import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import type {
  Asset,
  AssetCategory,
  DepreciationMethod,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'

/**
 * Default BAS account triples per category. The user can override at create
 * time; these only kick in when the form doesn't specify accounts. Matches
 * the seeded BAS 2020 chart (lib/bookkeeping/bas-data/).
 */
export const DEFAULT_ACCOUNTS_BY_CATEGORY: Record<
  AssetCategory,
  { asset: string; accumulated: string; expense: string }
> = {
  immaterial: { asset: '1010', accumulated: '1019', expense: '7810' },
  building: { asset: '1110', accumulated: '1119', expense: '7821' },
  land_improvement: { asset: '1150', accumulated: '1159', expense: '7824' },
  machinery: { asset: '1210', accumulated: '1219', expense: '7831' },
  equipment: { asset: '1220', accumulated: '1229', expense: '7832' },
  vehicle: { asset: '1240', accumulated: '1249', expense: '7834' },
  computer: { asset: '1250', accumulated: '1259', expense: '7833' },
  other_tangible: { asset: '1280', accumulated: '1289', expense: '7839' },
}

export interface CreateAssetInput {
  name: string
  category: AssetCategory
  acquisition_date: string
  acquisition_cost: number
  salvage_value?: number
  useful_life_months: number
  depreciation_method?: DepreciationMethod
  bas_asset_account?: string
  bas_accumulated_account?: string
  bas_expense_account?: string
  notes?: string
}

/**
 * Create a new asset. Defaults BAS accounts from the category mapping when
 * the caller doesn't override them. Does NOT post a journal entry — the
 * acquisition is assumed to already be in the books (bank payment or
 * supplier invoice). Posting an acquisition entry alongside an existing
 * payment would double-count.
 */
export async function createAsset(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateAssetInput,
): Promise<Asset> {
  const defaults = DEFAULT_ACCOUNTS_BY_CATEGORY[input.category]
  const row = {
    user_id: userId,
    company_id: companyId,
    name: input.name,
    category: input.category,
    acquisition_date: input.acquisition_date,
    acquisition_cost: input.acquisition_cost,
    salvage_value: input.salvage_value ?? 0,
    useful_life_months: input.useful_life_months,
    depreciation_method: input.depreciation_method ?? 'linear',
    bas_asset_account: input.bas_asset_account ?? defaults.asset,
    bas_accumulated_account: input.bas_accumulated_account ?? defaults.accumulated,
    bas_expense_account: input.bas_expense_account ?? defaults.expense,
    notes: input.notes ?? null,
  }

  const { data, error } = await supabase
    .from('assets')
    .insert(row)
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create asset: ${error?.message ?? 'unknown'}`)
  }
  return data as Asset
}

export async function listAssets(
  supabase: SupabaseClient,
  companyId: string,
  options: { activeOnly?: boolean } = {},
): Promise<Asset[]> {
  let query = supabase
    .from('assets')
    .select('*')
    .eq('company_id', companyId)
    .order('acquisition_date', { ascending: true })

  if (options.activeOnly) {
    query = query.is('disposed_at', null)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to list assets: ${error.message}`)
  return (data ?? []) as Asset[]
}

export async function getAsset(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
): Promise<Asset | null> {
  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .eq('id', assetId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load asset: ${error.message}`)
  return (data as Asset | null) ?? null
}

export interface UpdateAssetInput {
  name?: string
  notes?: string | null
  /** Salvage value, useful life, method, accounts — editable as long as the
   *  asset isn't disposed yet (DB trigger enforces this beyond the API). */
  salvage_value?: number
  useful_life_months?: number
  depreciation_method?: DepreciationMethod
  bas_asset_account?: string
  bas_accumulated_account?: string
  bas_expense_account?: string
}

export async function updateAsset(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  input: UpdateAssetInput,
): Promise<Asset> {
  // Defense-in-depth: when callers remap BAS accounts, refuse anything
  // outside the legitimate range for the existing asset's category — keeps
  // INK2R mappings + the depreciation engine's category-driven defaults in
  // sync with what users actually pick.
  if (
    input.bas_asset_account ||
    input.bas_accumulated_account ||
    input.bas_expense_account
  ) {
    const existing = await getAsset(supabase, companyId, assetId)
    if (!existing) throw new Error('Asset not found')
    const ranges = BAS_RANGES_BY_CATEGORY[existing.category]
    if (input.bas_asset_account && !inBasRange(input.bas_asset_account, ranges.asset)) {
      throw new Error(
        `bas_asset_account ${input.bas_asset_account} is outside ${ranges.asset[0]}–${ranges.asset[1]} for ${existing.category}`,
      )
    }
    if (
      input.bas_accumulated_account &&
      !inBasRange(input.bas_accumulated_account, ranges.accumulated)
    ) {
      throw new Error(
        `bas_accumulated_account ${input.bas_accumulated_account} is outside ${ranges.accumulated[0]}–${ranges.accumulated[1]} for ${existing.category}`,
      )
    }
    if (
      input.bas_expense_account &&
      !inBasRange(input.bas_expense_account, ranges.expense)
    ) {
      throw new Error(
        `bas_expense_account ${input.bas_expense_account} is outside ${ranges.expense[0]}–${ranges.expense[1]} for ${existing.category}`,
      )
    }
    // Anskaffning and ackumulerade-avskrivningar must be different accounts —
    // see CreateAssetSchema validateBasOverrides for the rationale.
    const finalAsset = input.bas_asset_account ?? existing.bas_asset_account
    const finalAccumulated = input.bas_accumulated_account ?? existing.bas_accumulated_account
    if (finalAsset === finalAccumulated) {
      throw new Error(
        'bas_asset_account and bas_accumulated_account must be different accounts',
      )
    }
  }

  const { data, error } = await supabase
    .from('assets')
    .update(input)
    .eq('id', assetId)
    .eq('company_id', companyId)
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to update asset: ${error?.message ?? 'unknown'}`)
  }
  return data as Asset
}

const BAS_RANGES_BY_CATEGORY: Record<
  AssetCategory,
  { asset: [string, string]; accumulated: [string, string]; expense: [string, string] }
> = {
  immaterial:      { asset: ['1010', '1099'], accumulated: ['1010', '1099'], expense: ['7810', '7819'] },
  building:        { asset: ['1100', '1199'], accumulated: ['1100', '1199'], expense: ['7820', '7829'] },
  land_improvement:{ asset: ['1150', '1159'], accumulated: ['1150', '1159'], expense: ['7820', '7829'] },
  machinery:       { asset: ['1210', '1219'], accumulated: ['1210', '1219'], expense: ['7830', '7839'] },
  equipment:       { asset: ['1220', '1229'], accumulated: ['1220', '1229'], expense: ['7830', '7839'] },
  vehicle:         { asset: ['1240', '1249'], accumulated: ['1240', '1249'], expense: ['7830', '7839'] },
  computer:        { asset: ['1250', '1259'], accumulated: ['1250', '1259'], expense: ['7830', '7839'] },
  other_tangible:  { asset: ['1280', '1299'], accumulated: ['1280', '1299'], expense: ['7830', '7839'] },
}

function inBasRange(account: string, range: [string, string]): boolean {
  return account >= range[0] && account <= range[1]
}

export interface DisposeAssetInput {
  /** ISO date of disposal — typically the day of sale or scrapping. */
  disposed_at: string
  /** Cash / receivable received for the asset. Zero for scrapping. */
  disposed_proceeds: number
  /** Optional override for the bank/receivable account credited with the
   *  proceeds. Defaults to 1930 (företagskonto). */
  proceeds_account?: string
  /** Fiscal period the disposal entry lands in. Caller resolves this from
   *  disposed_at — we don't auto-derive to keep the period-lock check at
   *  the route layer. */
  fiscal_period_id: string
}

export interface DisposalResult {
  asset: Asset
  /** Disposal entry. Null when no entry was needed (zero-value, fully-
   *  depreciated asset scrapped for nothing). */
  disposal_entry: JournalEntry | null
  gain_or_loss: number
}

/**
 * Dispose of an asset. Posts a journal entry that:
 *   - Debit accumulated depreciation (to zero out the asset's accumulated
 *     account)
 *   - Credit acquisition cost (to zero out the asset's anskaffning account)
 *   - Debit proceeds account (bank / receivable) for sale price
 *   - Debit 78xx (loss on sale) OR Credit 30xx (gain on sale) — accounts
 *     branch on category (3013/7813 for immaterial, 3973/7973 for tangible).
 *
 * After posting, marks the asset row with disposed_at / disposed_proceeds.
 * The DB trigger then prevents further edits to financial fields.
 *
 * KNOWN LIMITATION (ML 3 kap 3 § / 7 kap 3 §): the sale of an
 * anläggningstillgång that had right-to-deduct VAT on acquisition is in
 * principle 25 % momspliktig. This function does NOT post output VAT on the
 * proceeds — callers must handle the VAT side separately (or use a manual
 * journal entry). UI surfacing disposal must warn the user. Adding a
 * vat_on_proceeds field is tracked as a follow-up.
 *
 * KNOWN LIMITATION (ML 9 kap 8–11 §§ — jämkning): when a building or
 * markanläggning is disposed of within the 10-year jämkningsperiod after
 * acquisition, previously deducted input VAT must be recalculated and may
 * have to be partially repaid. This function does NOT compute or post any
 * jämkning adjustment. UI surfacing disposal for category='building' or
 * 'land_improvement' must check the 10-year window against acquisition_date
 * and warn the user; the actual recalculation belongs in a future
 * dedicated flow.
 */
export async function disposeAsset(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  assetId: string,
  input: DisposeAssetInput,
): Promise<DisposalResult> {
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new Error('Asset not found')
  if (asset.disposed_at) {
    throw new Error('Asset is already disposed')
  }

  // Derive accumulated depreciation server-side from posted
  // depreciation_schedules so a malicious or buggy caller cannot inflate the
  // book-value calculation. Limitation: manual avskrivningsverifikationer
  // posted outside the engine aren't captured here. Phase 5+ can replace
  // this with a trial-balance scan on bas_accumulated_account.
  const accumulated = await sumPostedDepreciation(supabase, companyId, assetId)

  const acquisitionCost = Number(asset.acquisition_cost)
  const proceeds = Number(input.disposed_proceeds)
  const netBookValue = acquisitionCost - accumulated
  const gainOrLoss = Math.round((proceeds - netBookValue) * 100) / 100
  const proceedsAccount = input.proceeds_account ?? '1930'

  const lines: CreateJournalEntryLineInput[] = []

  if (accumulated > 0.005) {
    lines.push({
      account_number: asset.bas_accumulated_account,
      debit_amount: Math.round(accumulated * 100) / 100,
      credit_amount: 0,
      line_description: `Avyttring: nollställ ack. avskrivning ${asset.name}`,
    })
  }
  lines.push({
    account_number: asset.bas_asset_account,
    debit_amount: 0,
    credit_amount: Math.round(acquisitionCost * 100) / 100,
    line_description: `Avyttring: nollställ anskaffning ${asset.name}`,
  })
  if (proceeds > 0.005) {
    lines.push({
      account_number: proceedsAccount,
      debit_amount: Math.round(proceeds * 100) / 100,
      credit_amount: 0,
      line_description: `Avyttring: erhållet belopp ${asset.name}`,
    })
  }
  // Disposal gain/loss accounts vary by asset class — BAS 2026 splits them
  // because INK2R routes each pair to a different field. Mixing them
  // misclassifies in the tax declaration.
  //   - immaterial            → 3013 (vinst) / 7813 (förlust)
  //   - building / markanlägg → 3971 / 7971
  //   - other tangible        → 3973 / 7973
  const isBuilding = asset.category === 'building' || asset.category === 'land_improvement'
  const gainAccount =
    asset.category === 'immaterial' ? '3013' : isBuilding ? '3971' : '3973'
  const lossAccount =
    asset.category === 'immaterial' ? '7813' : isBuilding ? '7971' : '7973'

  if (gainOrLoss > 0.005) {
    lines.push({
      account_number: gainAccount,
      debit_amount: 0,
      credit_amount: gainOrLoss,
      line_description: `Vinst vid avyttring av ${asset.name}`,
    })
  } else if (gainOrLoss < -0.005) {
    lines.push({
      account_number: lossAccount,
      debit_amount: Math.abs(gainOrLoss),
      credit_amount: 0,
      line_description: `Förlust vid avyttring av ${asset.name}`,
    })
  }

  let disposalEntry: JournalEntry | null = null
  if (lines.length > 0) {
    disposalEntry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: input.fiscal_period_id,
      entry_date: input.disposed_at,
      description: `Avyttring av tillgång: ${asset.name}`,
      source_type: 'manual',
      voucher_series: 'A',
      lines,
    })
  }

  const { data: updated, error: updateError } = await supabase
    .from('assets')
    .update({
      disposed_at: input.disposed_at,
      disposed_proceeds: proceeds,
    })
    .eq('id', assetId)
    .eq('company_id', companyId)
    .select('*')
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to mark asset disposed: ${updateError?.message ?? 'unknown'}`)
  }

  return {
    asset: updated as Asset,
    disposal_entry: disposalEntry,
    gain_or_loss: gainOrLoss,
  }
}

/**
 * Sum every posted depreciation_schedules row for an asset to get accumulated
 * depreciation as of "now". Used by disposeAsset so the caller cannot
 * influence the book-value calculation.
 */
async function sumPostedDepreciation(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('depreciation_schedules')
    .select('planned_depreciation')
    .eq('company_id', companyId)
    .eq('asset_id', assetId)
    .not('journal_entry_id', 'is', null)

  if (error) {
    throw new Error(`Failed to sum depreciation for asset ${assetId}: ${error.message}`)
  }

  type Row = { planned_depreciation: number | string }
  return ((data ?? []) as Row[]).reduce(
    (sum, row) => sum + (Number(row.planned_depreciation) || 0),
    0,
  )
}
