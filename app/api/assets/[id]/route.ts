import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { getAsset, updateAsset } from '@/lib/bokslut/assets/asset-service'
import type { DepreciationMethod } from '@/types'

const DEPRECIATION_METHODS: readonly DepreciationMethod[] = [
  'linear',
  'declining_balance_30',
  'declining_balance_20',
] as const

// Engine only implements linear today — reject declining_balance methods on
// both create and update until the engine grows them. The DB enum keeps the
// other methods reserved for a future phase.
const SUPPORTED_DEPRECIATION_METHODS: readonly DepreciationMethod[] = ['linear'] as const

const UpdateAssetSchema = z.object({
  name: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  salvage_value: z.number().nonnegative().optional(),
  useful_life_months: z.number().int().positive().optional(),
  depreciation_method: z
    .enum(DEPRECIATION_METHODS as unknown as [DepreciationMethod, ...DepreciationMethod[]])
    .optional()
    .refine(
      (m) => m === undefined || (SUPPORTED_DEPRECIATION_METHODS as readonly string[]).includes(m),
      {
        message:
          'Only "linear" depreciation is supported by the engine today. ' +
          'Declining-balance methods are reserved for a future phase.',
      },
    ),
  bas_asset_account: z.string().regex(/^\d{4}$/).optional(),
  bas_accumulated_account: z.string().regex(/^\d{4}$/).optional(),
  bas_expense_account: z.string().regex(/^\d{4}$/).optional(),
})

export const GET = withRouteContext(
  'assets.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const asset = await getAsset(supabase, companyId, id)
      if (!asset) {
        return NextResponse.json({ error: { code: 'ASSET_NOT_FOUND' } }, { status: 404 })
      }
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
)

export const PATCH = withRouteContext(
  'assets.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, UpdateAssetSchema)
    if (!validation.success) return validation.response
    try {
      const asset = await updateAsset(supabase, companyId, id, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
