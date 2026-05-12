/**
 * GET /api/v1/companies/{companyId}/customers — list customers.
 *
 * Cursor pagination on (created_at ASC, id ASC). Archived customers are
 * excluded by default; pass `?include_archived=true` to include them.
 *
 * Filters:
 *   - customer_type     CustomerType
 *   - search            substring match on name OR org_number prefix
 *   - include_archived  boolean (default false)
 */

import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const CustomerType = z.enum([
  'individual',
  'business',
  'eu_business',
  'eu_individual',
  'non_eu',
])

const CustomerSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  customer_type: CustomerType,
  email: z.string().nullable(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  default_payment_terms: z.number(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
})

const CustomersListResponse = z.object({
  customers: z.array(CustomerSummary),
})

// Explicit projection — never SELECT *. Schema migrations adding columns
// must update this list before the field becomes visible on the public API.
const CUSTOMER_SUMMARY_COLUMNS =
  'id, name, customer_type, email, org_number, vat_number, default_payment_terms, archived_at, created_at'

registerEndpoint({
  operation: 'customers.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/customers',
  summary: 'List customers for a company.',
  description:
    'Returns active customers in created-first order. Pass ?include_archived=true to include archived rows. Use ?search to match against name or org_number.',
  useWhen:
    'You need a customer roster — for building a UI picker, syncing a CRM, or resolving a customer_id before creating an invoice.',
  doNotUseFor:
    'Fetching a single customer you already know the id of — use GET /api/v1/companies/{companyId}/customers/{id}. Suppliers are a separate resource.',
  pitfalls: [
    'Archived customers are hidden by default; the dashboard makes the same choice.',
    'org_number is included so callers can match against external CRM identifiers; for sole traders (enskild firma) it equals the personnummer.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'a8f1…',
          name: 'Acme AB',
          customer_type: 'business',
          email: 'finance@acme.example',
          org_number: '556677-8899',
          vat_number: 'SE556677889901',
          default_payment_terms: 30,
          archived_at: null,
          created_at: '2025-04-12T08:30:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'customers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: CustomersListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'customers.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const FiltersSchema = z.object({
      customer_type: CustomerType.optional(),
      search: z.string().min(1).max(200).optional(),
      include_archived: z.enum(['true', 'false']).optional(),
    })
    const filtersResult = FiltersSchema.safeParse({
      customer_type: url.searchParams.get('customer_type') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      include_archived: url.searchParams.get('include_archived') ?? undefined,
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
    const includeArchived = filters.include_archived === 'true'

    let query = ctx.supabase
      .from('customers')
      .select(CUSTOMER_SUMMARY_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (!includeArchived) {
      query = query.is('archived_at', null)
    }
    if (filters.customer_type) {
      query = query.eq('customer_type', filters.customer_type)
    }
    if (filters.search) {
      // Build a safe ilike pattern. Two layers of escaping:
      //   1. PostgREST `.or()` filter syntax uses commas + parens as
      //      delimiters; strip them from the user-supplied term.
      //   2. SQL LIKE treats `%` and `_` (and `\` as the default escape) as
      //      wildcards; escape them so '100%' searches for the literal
      //      string '100%' rather than 'anything containing 100'.
      const term = filters.search
        .replace(/[,()]/g, '')      // PostgREST delimiters
        .replace(/[%_\\]/g, '\\$&') // LIKE wildcards
      query = query.or(`name.ilike.%${term}%,org_number.ilike.${term}%`)
    }

    if (decoded) {
      query = query.or(
        `created_at.gt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`,
      )
    }

    const { data, error } = await query

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    type Row = {
      id: string
      name: string
      customer_type: string
      email: string | null
      org_number: string | null
      vat_number: string | null
      default_payment_terms: number
      archived_at: string | null
      created_at: string
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    // GDPR Art.5(1)(c) data minimisation: for sole traders (enskild firma)
    // and EU-individual customers, org_number IS the personnummer — a
    // directly identifying special-category identifier. Mask both
    // org_number and vat_number in the LIST response for those types so
    // bulk fetches don't expose personal IDs. The DETAIL endpoint (deliberate
    // drill-in to one record) still returns them. Business customers'
    // org_numbers are Bolagsverket public-record data and stay visible.
    const INDIVIDUAL_TYPES = new Set(['individual', 'eu_individual'])

    const customers = trimmed.map((r) => {
      const isIndividual = INDIVIDUAL_TYPES.has(r.customer_type)
      return {
        id: r.id,
        name: r.name,
        customer_type: r.customer_type,
        email: r.email,
        org_number: isIndividual ? null : r.org_number,
        vat_number: isIndividual ? null : r.vat_number,
        default_payment_terms: r.default_payment_terms,
        archived_at: r.archived_at,
        created_at: r.created_at,
      }
    })

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(customers, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)
