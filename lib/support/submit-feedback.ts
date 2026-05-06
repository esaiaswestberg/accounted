export interface SubmitFeedbackInput {
  message: string
  subject?: string
}

export interface SubmitFeedbackResult {
  ok: boolean
  channel: 'recapt' | 'email'
  error?: string
}

function composeMessage({ message, subject }: SubmitFeedbackInput): string {
  if (!subject) return message
  return `[${subject}]\n\n${message}`
}

async function submitViaEmail({ message, subject }: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  try {
    const res = await fetch('/api/support/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return { ok: false, channel: 'email', error: data.error || 'Kunde inte skicka meddelandet' }
    }
    return { ok: true, channel: 'email' }
  } catch (err) {
    return { ok: false, channel: 'email', error: err instanceof Error ? err.message : 'Nätverksfel' }
  }
}

export async function submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  const recapt = typeof window !== 'undefined' ? window.recapt : undefined
  const fullMessage = composeMessage(input)

  if (typeof recapt === 'function') {
    try {
      recapt('feedback', { message: fullMessage })
      return { ok: true, channel: 'recapt' }
    } catch {
      // fall through to email
    }
  }

  return submitViaEmail(input)
}
