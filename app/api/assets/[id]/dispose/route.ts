import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { disposeAsset } from '@/lib/bokslut/assets/asset-service'

const DisposeAssetSchema = z.object({
  disposed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  disposed_proceeds: z.number().nonnegative(),
  proceeds_account: z.string().regex(/^\d{4}$/).optional(),
  fiscal_period_id: z.string().uuid(),
  // accumulated_depreciation is intentionally NOT accepted from the client —
  // disposeAsset sums depreciation_schedules server-side so callers cannot
  // inflate the book-value calculation.
})

export const POST = withRouteContext(
  'assets.dispose',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, DisposeAssetSchema)
    if (!validation.success) return validation.response
    try {
      const result = await disposeAsset(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data: result })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
