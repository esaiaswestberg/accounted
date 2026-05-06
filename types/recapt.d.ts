type RecaptFeedbackPayload =
  | { message: string; rating?: number }
  | { widget: 'show' | 'hide' | 'open' | 'close'; position?: string }

declare global {
  interface Window {
    recapt?: (action: 'feedback', data: RecaptFeedbackPayload) => void
  }
}

export {}
