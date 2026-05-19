'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import { Plus, Repeat, Lock, AlertTriangle } from 'lucide-react'
import type { RecurringInvoiceSchedule, Customer } from '@/types'

type ScheduleRow = RecurringInvoiceSchedule & {
  customer?: Pick<Customer, 'id' | 'name' | 'email'>
}

export default function RecurringInvoicesPage() {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const router = useRouter()

  async function fetchSchedules() {
    setIsLoading(true)
    try {
      const res = await fetch('/api/invoices/recurring')
      if (!res.ok) throw new Error('failed')
      const json = await res.json()
      setSchedules(json.data ?? [])
    } catch {
      toast({
        title: 'Kunde inte ladda återkommande fakturor',
        description: 'Kontrollera din anslutning och försök igen.',
        variant: 'destructive',
      })
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchSchedules()
  }, [])

  async function togglePause(s: ScheduleRow) {
    const next = s.status === 'active' ? 'paused' : 'active'
    const res = await fetch(`/api/invoices/recurring/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    })
    if (res.ok) {
      toast({
        title: next === 'paused' ? 'Schema pausat' : 'Schema återaktiverat',
      })
      fetchSchedules()
    } else {
      toast({
        title: 'Kunde inte uppdatera schema',
        variant: 'destructive',
      })
    }
  }

  async function deleteSchedule(s: ScheduleRow) {
    if (!confirm(`Ta bort schemat "${s.name}"? Redan skapade fakturor påverkas inte.`)) {
      return
    }
    const res = await fetch(`/api/invoices/recurring/${s.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: 'Schema borttaget' })
      fetchSchedules()
    } else {
      toast({ title: 'Kunde inte ta bort schema', variant: 'destructive' })
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Återkommande fakturor"
        action={
          canWrite ? (
            <Link href="/invoices/recurring/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Nytt schema
              </Button>
            </Link>
          ) : (
            <Button disabled title="Du har endast läsbehörighet i detta företag">
              <Lock className="mr-2 h-4 w-4" />
              Nytt schema
            </Button>
          )
        }
      />

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Laddar...
          </CardContent>
        </Card>
      ) : schedules.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Repeat}
              title="Inga återkommande fakturor"
              description="Skapa ett schema för att automatiskt fakturera kunder på en bestämd dag varje månad."
              actionLabel={canWrite ? 'Nytt schema' : undefined}
              actionHref={canWrite ? '/invoices/recurring/new' : undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Namn</TableHead>
                  <TableHead>Kund</TableHead>
                  <TableHead className="tabular-nums">Dag</TableHead>
                  <TableHead className="tabular-nums">Nästa körning</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="tabular-nums text-right">Skapade</TableHead>
                  <TableHead className="text-right">Åtgärder</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/invoices/recurring/${s.id}`)}
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {s.name}
                        {s.last_run_warning && (
                          <AlertTriangle
                            className="h-4 w-4 text-warning-foreground"
                            aria-label={s.last_run_warning}
                          />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.customer?.name ?? '—'}
                    </TableCell>
                    <TableCell className="tabular-nums">{s.day_of_month}</TableCell>
                    <TableCell className="tabular-nums">{formatDate(s.next_run_date)}</TableCell>
                    <TableCell>
                      {s.status === 'active' ? (
                        <Badge variant="success">Aktiv</Badge>
                      ) : (
                        <Badge variant="secondary">Pausad</Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-right">
                      {s.generated_count}
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="flex justify-end gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {canWrite && (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => togglePause(s)}
                            >
                              {s.status === 'active' ? 'Pausa' : 'Aktivera'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => deleteSchedule(s)}
                            >
                              Ta bort
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
