import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { submitFeedback } from '@/lib/support/submit-feedback'

describe('submitFeedback', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubRecapt(impl: (...args: unknown[]) => void) {
    vi.stubGlobal('window', { recapt: impl })
  }

  function stubNoRecapt() {
    vi.stubGlobal('window', {})
  }

  it('uses Recapt when SDK is present and prepends subject', async () => {
    const recapt = vi.fn()
    stubRecapt(recapt)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await submitFeedback({ subject: 'Hjälpsida', message: 'Hjälp tack' })

    expect(result).toEqual({ ok: true, channel: 'recapt' })
    expect(recapt).toHaveBeenCalledWith('feedback', { message: '[Hjälpsida]\n\nHjälp tack' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses Recapt without subject prefix when subject omitted', async () => {
    const recapt = vi.fn()
    stubRecapt(recapt)

    await submitFeedback({ message: 'plain' })

    expect(recapt).toHaveBeenCalledWith('feedback', { message: 'plain' })
  })

  it('falls back to email when Recapt throws', async () => {
    stubRecapt(() => {
      throw new Error('boom')
    })
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await submitFeedback({ subject: 'X', message: 'msg' })

    expect(result).toEqual({ ok: true, channel: 'email' })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/support/contact',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ subject: 'X', message: 'msg' }),
      })
    )
  })

  it('falls back to email when Recapt SDK is absent', async () => {
    stubNoRecapt()
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await submitFeedback({ message: 'msg' })

    expect(result).toEqual({ ok: true, channel: 'email' })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('returns failure with error from email when fetch returns non-ok', async () => {
    stubNoRecapt()
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Mailtjänsten är inte konfigurerad' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(false)
    expect(result.channel).toBe('email')
    expect(result.error).toBe('Mailtjänsten är inte konfigurerad')
  })

  it('returns failure when fetch itself throws', async () => {
    stubNoRecapt()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')))

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('Network down')
  })
})
