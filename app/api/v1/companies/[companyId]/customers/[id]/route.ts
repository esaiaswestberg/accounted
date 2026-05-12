/**
 * GET /api/v1/companies/{companyId}/customers/{id} — customer detail.
 *
 * Returns the full customer record. Pass `?expand=invoices` to embed open
 * (non-paid, non-cancelled, non-credited) invoices for the customer.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const CustomerDetail = z.object({
  id: z.string().uuid(),
  name: z.string(),
  customer_type: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  vat_number_validated: z.boolean(),
  default_payment_terms: z.number(),
  notes: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const ALLOWED_EXPAND = ['invoices'] as const
const OPEN_INVOICE_STATUSES = ['sent', 'partially_paid', 'overdue']

// Explicit projection. Excludes user_id, company_id (internal scoping),
// and vat_number_validated_at (internal timestamp not in the public schema).
const CUSTOMER_DETAIL_COLUMNS =
  'id, name, customer_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, default_payment_terms, notes, archived_at, created_at, updated_at'

const OPEN_INVOICE_COLUMNS =
  'id, invoice_number, invoice_date, due_date, status, currency, total, remaining_amount'

registerEndpoint({
  operation: 'customers.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/customers/:id',
  summary: 'Retrieve a single customer by id.',
  description:
    'Returns the full customer record. Pass ?expand=invoices to embed any open invoices (sent / partially_paid / overdue) for the customer in the same response.',
  useWhen:
    'You need the full customer record — address, payment terms, VAT validation status, contact details — before invoicing or syncing to another system.',
  doNotUseFor:
    'Listing customers (use the list endpoint). Looking up arbitrary supplier or employee records (different resources).',
  pitfalls: [
    'archived_at is non-null when the customer has been soft-deleted; the customer is still queryable by id but excluded from default lists.',
    'vat_number_validated reflects the last successful VIES check; it can become stale if the EU registry revokes a number.',
  ],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        name: 'Acme AB',
        customer_type: 'business',
        email: 'finance@acme.example',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vat_number_validated: true,
        country: 'Sweden',
        default_payment_terms: 30,
        archived_at: null,
        created_at: '2025-04-12T08:30:00Z',
        updated_at: '2026-04-30T11:22:09Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'customers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: CustomerDetail },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'customers.get',
  async (request, ctx, params) => {
    const { id } = await params.params

    // Defense in depth: validate the path id is a UUID before touching the
    // database or reflecting it in error details.
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Customer id must be a UUID.' },
      })
    }
    const customerId = idParse.data

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

    const { data: customer, error } = await ctx.supabase
      .from('customers')
      .select(CUSTOMER_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', customerId)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!customer) {
      // Generic NOT_FOUND — do not echo the queried id back to the caller
      // (enumeration hardening).
      ctx.log.warn('customers.get: not found', { customerId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'customer' },
      })
    }

    // Open invoices expansion — separate query to avoid bloating the
    // customer base shape with a join that's only sometimes needed.
    let invoices: unknown[] | undefined
    const partialExpansions: string[] = []
    if (expand.has('invoices')) {
      const { data: invs, error: invErr } = await ctx.supabase
        .from('invoices')
        .select(OPEN_INVOICE_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('customer_id', customerId)
        .in('status', OPEN_INVOICE_STATUSES)
        .order('invoice_date', { ascending: false })

      if (invErr) {
        // Soft-degrade: log but still return the customer. The agent gets
        // the primary resource; ?expand is a hint, not a guarantee.
        // `meta.partial_expansions` signals which expansions failed so
        // careful callers can retry or fall back without parsing the body.
        const errMsg = (invErr as { code?: string; message?: string }).message ?? 'unknown'
        const errCode = (invErr as { code?: string }).code ?? 'unknown'
        // Postgres error class 42 = "Syntax Error or Access Rule Violation"
        // (includes 42501 insufficient_privilege). These indicate a real
        // misconfiguration — a revoked grant or an incorrect RLS policy —
        // and should reach Sentry/error monitoring rather than blending
        // into informational warn logs. Other classes are typically
        // transient (network, timeout) and stay at warn.
        const isPermissionError = typeof errCode === 'string' && errCode.startsWith('42')
        if (isPermissionError) {
          ctx.log.error('customers.get: open-invoices expansion permission denied', new Error(errMsg), {
            errCode,
            customerId,
          })
        } else {
          ctx.log.warn('customers.get: open-invoices expansion failed', { errCode, errMsg })
        }
        invoices = []
        partialExpansions.push('invoices')
      } else {
        invoices = invs ?? []
      }
    }

    return ok(
      { ...customer, ...(invoices !== undefined ? { invoices } : {}) },
      {
        requestId: ctx.requestId,
        partialExpansions: partialExpansions.length > 0 ? partialExpansions : undefined,
      },
    )
  },
)
