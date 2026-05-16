'use client'

import { useCallback, useEffect, useState } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Package, Plus } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { Asset, AssetCategory } from '@/types'
import { CreateAssetDialog } from '@/components/bookkeeping/assets/CreateAssetDialog'

const CATEGORY_LABELS: Record<AssetCategory, string> = {
  immaterial: 'Immateriell',
  building: 'Byggnad',
  land_improvement: 'Markanläggning',
  machinery: 'Maskin',
  equipment: 'Inventarier',
  vehicle: 'Fordon',
  computer: 'Dator',
  other_tangible: 'Övriga materiella',
}

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Bumped on create to re-trigger the effect.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/assets')
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setError('Kunde inte ladda tillgångar')
          return
        }
        const { data } = (await res.json()) as { data: Asset[] }
        if (cancelled) return
        setError(null)
        setAssets(data)
      })
      .catch(() => {
        if (!cancelled) setError('Kunde inte ladda tillgångar')
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const handleCreated = useCallback(() => {
    setDialogOpen(false)
    setReloadKey((k) => k + 1)
  }, [])

  return (
    <div className="space-y-8">
      <PageHeader
        title="Anläggningstillgångar"
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Ny tillgång
          </Button>
        }
      />

      {assets === null && !error && (
        <Card>
          <CardContent className="p-6 space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardContent className="p-6 text-destructive">{error}</CardContent>
        </Card>
      )}

      {assets !== null && assets.length === 0 && (
        <EmptyState
          icon={Package}
          title="Inga tillgångar än"
          description="Lägg till anläggningstillgångar (datorer, möbler, fordon, maskiner) så räknar bokslutet planenliga avskrivningar automatiskt."
          actionLabel="Ny tillgång"
          onAction={() => setDialogOpen(true)}
        />
      )}

      {assets !== null && assets.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Namn</TableHead>
                  <TableHead>Kategori</TableHead>
                  <TableHead>Anskaffat</TableHead>
                  <TableHead className="text-right">Anskaffningsvärde</TableHead>
                  <TableHead>Avskrivningstid</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((asset) => {
                  const years = Math.round(asset.useful_life_months / 12)
                  return (
                    <TableRow key={asset.id}>
                      <TableCell className="font-medium">{asset.name}</TableCell>
                      <TableCell className="text-sm">{CATEGORY_LABELS[asset.category]}</TableCell>
                      <TableCell className="tabular-nums">
                        {formatDate(asset.acquisition_date)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(Number(asset.acquisition_cost))}
                      </TableCell>
                      <TableCell className="text-sm">
                        {years} år ({asset.useful_life_months} mån)
                      </TableCell>
                      <TableCell>
                        {asset.disposed_at ? (
                          <Badge variant="secondary">Avyttrad</Badge>
                        ) : (
                          <Badge variant="success">Aktiv</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CreateAssetDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={handleCreated} />
    </div>
  )
}
