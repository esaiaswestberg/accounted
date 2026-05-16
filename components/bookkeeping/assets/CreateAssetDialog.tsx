'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import type { AssetCategory } from '@/types'

interface CreateAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

// Defaults are K2-redovisning (BFNAR 2016:10) schablon, NOT skattemässig
// avskrivning. Building / markanläggning values are conservative — IL 19/20
// kap may allow longer (50 yr) or shorter (10 yr) depending on byggnadstyp.
const CATEGORY_OPTIONS: { value: AssetCategory; label: string; defaultYears: number }[] = [
  { value: 'computer', label: 'Dator / IT-utrustning', defaultYears: 3 },
  { value: 'equipment', label: 'Inventarier', defaultYears: 5 },
  { value: 'machinery', label: 'Maskiner', defaultYears: 10 },
  { value: 'vehicle', label: 'Fordon', defaultYears: 5 },
  { value: 'building', label: 'Byggnad', defaultYears: 25 },
  { value: 'land_improvement', label: 'Markanläggning', defaultYears: 10 },
  { value: 'immaterial', label: 'Immateriell tillgång', defaultYears: 5 },
  { value: 'other_tangible', label: 'Övrig materiell tillgång', defaultYears: 5 },
]

export function CreateAssetDialog({ open, onOpenChange, onCreated }: CreateAssetDialogProps) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [category, setCategory] = useState<AssetCategory>('equipment')
  const [acquisitionDate, setAcquisitionDate] = useState(
    new Date().toISOString().split('T')[0],
  )
  const [acquisitionCost, setAcquisitionCost] = useState('')
  const [usefulLifeYears, setUsefulLifeYears] = useState('5')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCategoryChange = (next: AssetCategory) => {
    setCategory(next)
    const option = CATEGORY_OPTIONS.find((o) => o.value === next)
    if (option) setUsefulLifeYears(option.defaultYears.toString())
  }

  const handleSubmit = async () => {
    setError(null)
    const cost = parseFloat(acquisitionCost)
    const years = parseInt(usefulLifeYears, 10)
    if (!name.trim() || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(years) || years <= 0) {
      setError('Fyll i namn, anskaffningsvärde och avskrivningstid.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          category,
          acquisition_date: acquisitionDate,
          acquisition_cost: cost,
          useful_life_months: years * 12,
          depreciation_method: 'linear',
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error?.message ?? 'Kunde inte spara tillgången')
        return
      }
      toast({ title: 'Tillgång sparad', description: name.trim() })
      // Reset form for next entry
      setName('')
      setAcquisitionCost('')
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Okänt fel')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ny anläggningstillgång</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="asset-name">Namn</Label>
            <Input
              id="asset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="t.ex. MacBook Pro 14"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-category">Kategori</Label>
            <Select value={category} onValueChange={(v) => handleCategoryChange(v as AssetCategory)}>
              <SelectTrigger id="asset-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="asset-date">Anskaffat</Label>
              <Input
                id="asset-date"
                type="date"
                value={acquisitionDate}
                onChange={(e) => setAcquisitionDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-cost">Anskaffningsvärde (kr)</Label>
              <Input
                id="asset-cost"
                type="number"
                step="1"
                min="0"
                value={acquisitionCost}
                onChange={(e) => setAcquisitionCost(e.target.value)}
                placeholder="t.ex. 25000"
                className="tabular-nums"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-life">Avskrivningstid (år)</Label>
            <Input
              id="asset-life"
              type="number"
              min="1"
              max="50"
              step="1"
              value={usefulLifeYears}
              onChange={(e) => setUsefulLifeYears(e.target.value)}
              className="tabular-nums"
            />
            <p className="text-xs text-muted-foreground">
              K2-schablon för redovisning: datorer 3 år, inventarier 5 år, byggnader 25 år.
              För skattemässig avskrivning kan annan livslängd gälla (IL 18–20 kap).
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Tips:</strong> Anskaffningen måste redan vara
            bokförd (debet på 1xxx-kontot mot t.ex. 1930/2440) — registret bokför inte
            själva köpet. Det här registret styr enbart de planenliga avskrivningarna under
            bokslutet.
          </div>
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Avbryt
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sparar…
              </>
            ) : (
              'Spara'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
