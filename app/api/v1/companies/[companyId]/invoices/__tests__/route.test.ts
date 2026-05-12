/**
 * Integration tests for GET /api/v1/companies/:companyId/invoices and
 * /api/v1/companies/:companyId/invoices/:id.
 *
 * Mocks validateApiKey + the service-role Supabase client. The mock supports
 * per-table results so the wrapper's `company_members` membership check and
 * the handler's `invoices` query both resolve correctly in the same call.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listInvoices } from '../route'
import { GET as getInvoice } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

/**
 * Build a Supabase client mock keyed by table name. Every chained method
 * call returns a proxy that resolves to byTable[table] when awaited.
 */
function makeFlexibleSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key', ...(init?.headers ?? {}) },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:read'],
    mode: 'live',
  })
})

const SAMPLE_INVOICE = {
  id: INVOICE_ID,
  invoice_number: '2026-0042',
  customer_id: CUSTOMER_ID,
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
  customer: { id: CUSTOMER_ID, name: 'Acme AB' },
}

describe('GET /api/v1/companies/:companyId/invoices', () => {
  it('returns a paginated invoice list with inline customer_name', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: [SAMPLE_INVOICE], error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].customer_name).toBe('Acme AB')
    expect(body.data[0].invoice_number).toBe('2026-0042')
    // Default response shape MUST NOT include the full customer object.
    expect(body.data[0].customer).toBeUndefined()
    expect(body.meta.request_id).toMatch(/^req_/)
  })

  it('embeds the full customer when ?expand=customer is requested', async () => {
    const sampleWithFullCustomer = {
      ...SAMPLE_INVOICE,
      customer: {
        id: CUSTOMER_ID,
        name: 'Acme AB',
        email: 'a@acme.test',
        country: 'Sweden',
      },
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: [sampleWithFullCustomer], error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?expand=customer`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].customer).toEqual(sampleWithFullCustomer.customer)
  })

  it('rejects unknown ?expand values with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?expand=bogus`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.invalidKeys).toEqual(['bogus'])
  })

  it('rejects an invalid currency filter (not ISO-4217)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?currency=sek`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('accepts a valid ISO-4217 currency code', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: [SAMPLE_INVOICE], error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?currency=SEK`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
  })

  it('rejects an invalid status filter', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?status=quantum`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('emits a next_cursor when the page is full', async () => {
    const overFetched = [
      SAMPLE_INVOICE,
      { ...SAMPLE_INVOICE, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    ]
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: overFetched, error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?limit=1`),
      companyParams(COMPANY_ID),
    )

    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.meta.next_cursor).toBeTruthy()
  })
})

describe('GET /api/v1/companies/:companyId/invoices/:id', () => {
  it('returns the invoice with the embedded customer', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SAMPLE_INVOICE, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(INVOICE_ID)
    expect(body.data.customer.name).toBe('Acme AB')
  })

  it('returns 404 when the invoice does not exist for the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('rejects unknown ?expand values', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}?expand=foo`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 VALIDATION_ERROR when :id is not a UUID', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/not-a-uuid`),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('id')
  })

  it('does not echo the queried id on 404 (enumeration hardening)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details).toEqual({ resource: 'invoice' })
    expect(body.error.details.id).toBeUndefined()
  })
})

describe('scope enforcement', () => {
  it('returns 403 INSUFFICIENT_SCOPE when key lacks invoices:read', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['customers:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns 404 when the URL companyId is not one the key user belongs to', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: null, error: null }, // no membership
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
