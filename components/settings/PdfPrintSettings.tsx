'use client'

import { useState, useCallback } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import type { CompanySettings } from '@/types'

interface PdfPrintSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

export function PdfPrintSettings({ settings, onUpdate }: PdfPrintSettingsProps) {
  const { toast } = useToast()
  const [lateFeeText, setLateFeeText] = useState(settings.invoice_late_fee_text || '')
  const [creditTermsText, setCreditTermsText] = useState(settings.invoice_credit_terms_text || '')

  const saveToggle = useCallback(async (field: string, value: boolean) => {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ [field]: value } as Partial<CompanySettings>)
    } catch {
      toast({ title: 'Kunde inte spara', variant: 'destructive' })
    }
  }, [onUpdate, toast])

  const savePosition = useCallback(async (value: 'header' | 'footer') => {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_company_name_position: value }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ invoice_company_name_position: value })
    } catch {
      toast({ title: 'Kunde inte spara', variant: 'destructive' })
    }
  }, [onUpdate, toast])

  const saveText = useCallback(async (field: string, value: string) => {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value || null }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ [field]: value || null } as Partial<CompanySettings>)
    } catch {
      toast({ title: 'Kunde inte spara', variant: 'destructive' })
    }
  }, [onUpdate, toast])

  return (
    <section className="space-y-6">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Utskrift & PDF
      </h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label>Öresavrundning</Label>
            <p className="text-xs text-muted-foreground">Avrunda fakturatotal till hel krona</p>
          </div>
          <Switch
            checked={settings.ore_rounding ?? true}
            onCheckedChange={(v) => saveToggle('ore_rounding', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Visa OCR-referens</Label>
            <p className="text-xs text-muted-foreground">Visa OCR-nummer på fakturautskrift</p>
          </div>
          <Switch
            checked={settings.invoice_show_ocr ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_ocr', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Visa bankgiro</Label>
            <p className="text-xs text-muted-foreground">Visa bankgironummer på fakturautskrift</p>
          </div>
          <Switch
            checked={settings.invoice_show_bankgiro ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_bankgiro', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Visa plusgiro</Label>
            <p className="text-xs text-muted-foreground">Visa plusgironummer på fakturautskrift</p>
          </div>
          <Switch
            checked={settings.invoice_show_plusgiro ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_plusgiro', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Visa logga</Label>
            <p className="text-xs text-muted-foreground">Visa uppladdad logga i fakturahuvudet</p>
          </div>
          <Switch
            checked={settings.invoice_show_logo ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_logo', v)}
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label>Visa företagsnamn i faktura</Label>
              <p className="text-xs text-muted-foreground">Visa företagsnamn i fakturan</p>
            </div>
            <Switch
              checked={settings.invoice_show_company_name ?? true}
              onCheckedChange={(v) => saveToggle('invoice_show_company_name', v)}
            />
          </div>
          {(settings.invoice_show_company_name ?? true) && (
            <div className="flex items-center justify-between pl-0">
              <p className="text-xs text-muted-foreground">Placering</p>
              <div
                role="group"
                aria-label="Placering av företagsnamn"
                className="inline-flex rounded-md border border-border/60 p-0.5"
              >
                {(['header', 'footer'] as const).map((pos) => {
                  const active = (settings.invoice_company_name_position ?? 'header') === pos
                  return (
                    <button
                      key={pos}
                      type="button"
                      aria-pressed={active}
                      onClick={() => savePosition(pos)}
                      className={
                        'h-10 px-4 text-sm rounded-sm transition-colors ' +
                        (active
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground hover:text-foreground')
                      }
                    >
                      {pos === 'header' ? 'Huvud' : 'Sidfot'}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4 pt-2">
        <div className="space-y-2">
          <Label htmlFor="invoice_late_fee_text">Dröjsmålsränta</Label>
          <Textarea
            id="invoice_late_fee_text"
            rows={2}
            placeholder="T.ex. Vid betalning efter förfallodagen debiteras ränta enligt räntelagen."
            value={lateFeeText}
            onChange={(e) => setLateFeeText(e.target.value)}
            onBlur={() => saveText('invoice_late_fee_text', lateFeeText)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice_credit_terms_text">Betalningsvillkor (fotnot)</Label>
          <Textarea
            id="invoice_credit_terms_text"
            rows={2}
            placeholder="T.ex. Betalning sker till angivet bankgiro."
            value={creditTermsText}
            onChange={(e) => setCreditTermsText(e.target.value)}
            onBlur={() => saveText('invoice_credit_terms_text', creditTermsText)}
          />
        </div>
      </div>
    </section>
  )
}
