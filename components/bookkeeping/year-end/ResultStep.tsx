'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CheckCircle2 } from 'lucide-react'
import Link from 'next/link'
import type { YearEndResult } from '@/types'

interface ResultStepProps {
  result: YearEndResult
}

export function ResultStep({ result }: ResultStepProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6 text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/10">
            <CheckCircle2 className="h-7 w-7 text-success" />
          </div>
          <h2 className="font-display text-2xl">Bokslutet är klart</h2>
          <p className="text-muted-foreground">
            Perioden är stängd och en ny räkenskapsperiod har skapats.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resultat</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ResultRow
            label="Bokslutsverifikation"
            value={`${result.closingEntry.voucher_series}${result.closingEntry.voucher_number}`}
            href={`/bookkeeping/${result.closingEntry.id}`}
          />
          {result.revaluationEntry && (
            <ResultRow
              label="Kursrevaluering"
              value={`${result.revaluationEntry.voucher_series}${result.revaluationEntry.voucher_number}`}
              href={`/bookkeeping/${result.revaluationEntry.id}`}
            />
          )}
          <ResultRow
            label="Ingående balanser i ny period"
            value={`${result.openingBalanceEntry.voucher_series}${result.openingBalanceEntry.voucher_number}`}
            href={`/bookkeeping/${result.openingBalanceEntry.id}`}
          />
          <ResultRow label="Ny räkenskapsperiod" value={result.nextPeriod.name} />
        </CardContent>
      </Card>

      <div className="flex flex-col sm:flex-row gap-3 sm:justify-end">
        <Button variant="outline" asChild>
          <Link href="/bookkeeping">Till bokföringen</Link>
        </Button>
        <Button asChild>
          <Link href="/reports">Generera rapporter</Link>
        </Button>
      </div>
    </div>
  )
}

function ResultRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border last:border-b-0 pb-3 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      {href ? (
        <Link href={href} className="font-medium tabular-nums text-primary hover:underline">
          {value}
        </Link>
      ) : (
        <span className="font-medium tabular-nums">{value}</span>
      )}
    </div>
  )
}
