/**
 * GET /api/v1/companies/{companyId}/invoices/{id} — invoice detail.
 *
 * Returns the full invoice record. Customer is embedded by default (the
 * detail endpoint is verbose by design); line items and payments require
 * `?expand=items,payments` to keep the default response shape predictable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

// Loose schema — detail responses carry many fields, and pinning the exact
// types in the registry is overkill until Phase 2 PR-B introduces writes
// that reuse the schema for validation.
const InvoiceDetail = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  customer_id: z.string().uuid(),
  invoice_date: z.string(),
  due_date: z.string(),
  status: z.string(),
  document_type: z.string(),
  currency: z.string(),
  total: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
})

const ALLOWED_EXPAND = ['items', 'payments'] as const

// Explicit projections. Detail endpoint is more verbose than list — includes
// VAT treatment, conversion, FX, and notes — but still drops user_id and
// company_id (internal scoping).
const INVOICE_DETAIL_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, moms_ruta, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type, converted_from_id, paid_at, paid_amount, remaining_amount, created_at, updated_at'

const CUSTOMER_DETAIL_COLUMNS =
  'id, name, customer_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, default_payment_terms, notes, archived_at, created_at, updated_at'

const INVOICE_ITEM_COLUMNS =
  'id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, created_at'

// Payment projection — drops invoice_id (redundant on the parent), user_id,
// company_id (internal scoping).
const INVOICE_PAYMENT_COLUMNS =
  'id, payment_date, amount, currency, exchange_rate, exchange_rate_difference, journal_entry_id, transaction_id, notes, created_at'

registerEndpoint({
  operation: 'invoices.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/invoices/:id',
  summary: 'Retrieve a single invoice by id.',
  description:
    'Returns the full invoice record with the customer embedded. Pass ?expand=items for line items, ?expand=payments for payment history, or ?expand=items,payments for both.',
  useWhen:
    'You have an invoice id (from a webhook, the list endpoint, or a customer transaction) and need the full record including amounts, dates, status, and the customer details.',
  doNotUseFor:
    'Listing invoices (use GET /api/v1/companies/{companyId}/invoices). Bookkeeping verifikationer tied to the invoice (use the journal-entries endpoints in a later phase).',
  pitfalls: [
    'Returns 404 if the invoice does not belong to the company in the URL — does not leak existence across companies.',
    'paid_at and remaining_amount can lag behind the latest payment by a few seconds during high-volume reconciliation.',
  ],
  example: {
    response: {
      data: {
        id: '0e9c…',
        invoice_number: '2026-0042',
        customer_id: 'a8f1…',
        customer: { id: 'a8f1…', name: 'Acme AB' },
        invoice_date: '2026-05-01',
        due_date: '2026-05-31',
        status: 'sent',
        total: 12500,
        remaining_amount: 12500,
        paid_at: null,
        created_at: '2026-05-01T09:14:33Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: InvoiceDetail },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.get',
  async (request, ctx, params) => {
    const { id } = await params.params

    // Defense in depth: validate the path id is a UUID before touching the
    // database or reflecting it in error details.
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    const url = new URL(request.url)

    const expandResult = parseExpand(url, ALLOWED_EXPAND)
    if (!expandResult.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'expand',
          invalidKeys: expandResult.invalidKeys,
          allowed: expandResult.allowed,
        },
      })
    }
    const expand = expandResult.expand

    const itemsSelect = expand.has('items') ? `, items:invoice_items(${INVOICE_ITEM_COLUMNS})` : ''
    const paymentsSelect = expand.has('payments')
      ? `, payments:invoice_payments(${INVOICE_PAYMENT_COLUMNS})`
      : ''
    const selectClause = `${INVOICE_DETAIL_COLUMNS}, customer:customers(${CUSTOMER_DETAIL_COLUMNS})${itemsSelect}${paymentsSelect}`

    const { data, error } = await ctx.supabase
      .from('invoices')
      .select(selectClause)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    if (!data) {
      // Generic NOT_FOUND — do not echo the queried id back to the caller.
      ctx.log.warn('invoices.get: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }

    return ok(data, { requestId: ctx.requestId })
  },
)
