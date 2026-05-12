/**
 * GET /api/v1/companies/{companyId}/invoices — list invoices.
 *
 * Cursor pagination on (invoice_date DESC, id DESC) — most recent first to
 * match AR UX. Customer name is denormalised into the response so the agent
 * doesn't need an N+1 fetch for display; use `?expand=customer` for the full
 * customer record.
 *
 * Filters (all optional):
 *   - status            single InvoiceStatus
 *   - customer_id       UUID
 *   - document_type     'invoice' | 'proforma' | 'delivery_note'
 *   - currency          ISO-4217 code
 */

import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const InvoiceStatus = z.enum([
  'draft',
  'sent',
  'paid',
  'partially_paid',
  'overdue',
  'cancelled',
  'credited',
])

const InvoiceDocumentType = z.enum(['invoice', 'proforma', 'delivery_note'])

const InvoiceSummary = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  customer_id: z.string().uuid(),
  customer_name: z.string(),
  invoice_date: z.string(),
  due_date: z.string(),
  status: InvoiceStatus,
  document_type: InvoiceDocumentType,
  currency: z.string(),
  subtotal: z.number(),
  vat_amount: z.number(),
  total: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
})

const InvoicesListResponse = z.object({
  invoices: z.array(InvoiceSummary),
})

const ALLOWED_EXPAND = ['customer', 'items'] as const

// Explicit projection — excludes user_id, company_id, and SEK-conversion
// fields not in the summary schema. Schema migrations adding columns must
// update this list before the field becomes visible on the public API.
const INVOICE_SUMMARY_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, status, document_type, currency, subtotal, vat_amount, total, remaining_amount, paid_at, created_at'

// Customer projections — three tiers for different contexts:
//   - NAME_ONLY: default for the invoice list (inline customer_name only)
//   - LIST_CONTEXT: ?expand=customer in a LIST endpoint. Contact-summary
//     subset only — full PII like address/phone/notes/vat_number lives on
//     the dedicated customer detail endpoint. GDPR Art.5(1)(c)
//     data-minimisation: bulk fetches should not transmit a full PII
//     record per row.
// All projections deliberately omit user_id, company_id, and
// vat_number_validated_at (internal scoping / timestamp).
const CUSTOMER_NAME_ONLY_COLUMNS = 'id, name'
const CUSTOMER_LIST_CONTEXT_COLUMNS = 'id, name, customer_type, email, country, archived_at'

// Invoice items projection — excludes invoice_id (redundant) and internal
// linkage fields not in the documented response shape.
const INVOICE_ITEM_COLUMNS =
  'id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, created_at'

registerEndpoint({
  operation: 'invoices.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/invoices',
  summary: 'List invoices for a company.',
  description:
    'Returns invoices in most-recent-first order. Includes the customer name inline; pass ?expand=customer for the full customer record, ?expand=items for line items.',
  useWhen:
    'You need to enumerate invoices for a company — for AR reporting, payment matching, or building an invoice dashboard.',
  doNotUseFor:
    'Fetching a single invoice you already know the id of — use GET /api/v1/companies/{companyId}/invoices/{id}. Supplier invoices are a different resource (supplier-invoices).',
  pitfalls: [
    'Draft invoices have invoice_number=null until they are sent.',
    'remaining_amount is the unpaid portion (total − paid_amount); use status=paid or remaining_amount=0 to filter for closed invoices.',
    'Credit notes appear with status=credited and a credited_invoice_id field on the detail endpoint.',
  ],
  example: {
    response: {
      data: [
        {
          id: '0e9c…',
          invoice_number: '2026-0042',
          customer_id: 'a8f1…',
          customer_name: 'Acme AB',
          invoice_date: '2026-05-01',
          due_date: '2026-05-31',
          status: 'sent',
          document_type: 'invoice',
          currency: 'SEK',
          subtotal: 10000,
          vat_amount: 2500,
          total: 12500,
          remaining_amount: 12500,
          paid_at: null,
          created_at: '2026-05-01T09:14:33Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'invoices:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: InvoicesListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'invoices.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    // Validate ?expand against the allowlist; reject unknown values clearly.
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

    // Validate query filters. Currency is strict ISO-4217 (3 uppercase
    // letters) — accepting arbitrary 3-8 char strings would pass through
    // to the DB filter without serving any documented purpose.
    const FiltersSchema = z.object({
      status: InvoiceStatus.optional(),
      customer_id: z.string().uuid().optional(),
      document_type: InvoiceDocumentType.optional(),
      currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code').optional(),
    })
    const filtersResult = FiltersSchema.safeParse({
      status: url.searchParams.get('status') ?? undefined,
      customer_id: url.searchParams.get('customer_id') ?? undefined,
      document_type: url.searchParams.get('document_type') ?? undefined,
      currency: url.searchParams.get('currency') ?? undefined,
    })
    if (!filtersResult.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: filtersResult.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const filters = filtersResult.data

    // Build the select clause. customer is always joined for the inline
    // customer_name; ?expand=customer upgrades it from a name-only shape to
    // the full record. ?expand=items pulls line items.
    const customerSelect = expand.has('customer')
      ? `customer:customers(${CUSTOMER_LIST_CONTEXT_COLUMNS})`
      : `customer:customers(${CUSTOMER_NAME_ONLY_COLUMNS})`
    const itemsSelect = expand.has('items') ? `, items:invoice_items(${INVOICE_ITEM_COLUMNS})` : ''
    const selectClause = `${INVOICE_SUMMARY_COLUMNS}, ${customerSelect}${itemsSelect}`

    let query = ctx.supabase
      .from('invoices')
      .select(selectClause)
      .eq('company_id', ctx.companyId!)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (filters.status) query = query.eq('status', filters.status)
    if (filters.customer_id) query = query.eq('customer_id', filters.customer_id)
    if (filters.document_type) query = query.eq('document_type', filters.document_type)
    if (filters.currency) query = query.eq('currency', filters.currency)

    if (decoded) {
      // Keyset on (invoice_date DESC, id DESC):
      //   invoice_date < ts OR (invoice_date = ts AND id < cursor_id)
      query = query.or(
        `invoice_date.lt.${decoded.ts},and(invoice_date.eq.${decoded.ts},id.lt.${decoded.id})`,
      )
    }

    const { data, error } = await query

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    // The joined customer can return as either an object or a single-element
    // array, mirroring the pattern in /companies. Pick safely.
    type CustomerObj = { id: string; name: string } & Record<string, unknown>
    type InvoiceRow = {
      id: string
      invoice_number: string | null
      customer_id: string
      invoice_date: string
      due_date: string
      status: string
      document_type: string
      currency: string
      subtotal: number
      vat_amount: number
      total: number
      remaining_amount: number
      paid_at: string | null
      created_at: string
      customer: CustomerObj | CustomerObj[] | null
      items?: unknown
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as InvoiceRow[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const pickCustomer = (c: InvoiceRow['customer']): CustomerObj | null => {
      if (!c) return null
      return Array.isArray(c) ? (c[0] ?? null) : c
    }

    const invoices = trimmed.map((r) => {
      const c = pickCustomer(r.customer)
      const base = {
        id: r.id,
        invoice_number: r.invoice_number,
        customer_id: r.customer_id,
        customer_name: c?.name ?? '',
        invoice_date: r.invoice_date,
        due_date: r.due_date,
        status: r.status,
        document_type: r.document_type,
        currency: r.currency,
        subtotal: r.subtotal,
        vat_amount: r.vat_amount,
        total: r.total,
        remaining_amount: r.remaining_amount,
        paid_at: r.paid_at,
        created_at: r.created_at,
      }
      return {
        ...base,
        ...(expand.has('customer') && c ? { customer: c } : {}),
        ...(expand.has('items') ? { items: r.items ?? [] } : {}),
      }
    })

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.invoice_date })
      : null

    return paginated(invoices, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)
