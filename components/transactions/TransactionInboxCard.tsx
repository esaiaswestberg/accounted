'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DataListRow,
  DataListPrimary,
  DataListMeta,
  DataListMetaSeparator,
} from '@/components/ui/data-list'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import {
  AlertCircle,
  ArrowUpRight,
  ArrowDownRight,
  FileText,
  Link2,
  Loader2,
  Trash2,
} from 'lucide-react'
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import type { TransactionWithInvoice, CategorizeHandler } from './transaction-types'

interface TransactionInboxCardProps {
  transaction: TransactionWithInvoice
  /** When set, this bank tx looks like the bank side of a 1930↔1630
   *  transfer that the user will later see on /skattekonto. */
  skvCounterpartDate?: string
  processingId: string | null
  isBatchMode: boolean
  isSelected: boolean
  entityType?: string
  onCategorize: CategorizeHandler
  /** Confirm an auto-detected invoice match (1-click shortcut). */
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  /** Open the manual picker — routes to customer or supplier picker by amount sign. */
  onOpenMatchInvoicePicker: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  onToggleSelect: (id: string) => void
  onAnimationComplete?: (id: string) => void
}

export default function TransactionInboxCard({
  transaction,
  skvCounterpartDate,
  processingId,
  isBatchMode,
  isSelected,
  onOpenMatchDialog,
  onOpenMatchInvoicePicker,
  onOpenCategoryDialog,
  onDelete,
  onToggleSelect,
  onAnimationComplete,
}: TransactionInboxCardProps) {
  const t = useTranslations('tx_inbox_card')
  const isProcessing = processingId === transaction.id
  const isDisabled = processingId !== null && processingId !== transaction.id
  const isIncome = transaction.amount > 0
  const hasInvoiceMatch = !!transaction.potential_invoice && !transaction.invoice_id
  const hasSupplierInvoiceMatch =
    !!transaction.potential_supplier_invoice && !transaction.supplier_invoice_id
  const isUncategorized = transaction.is_business === null && !transaction.journal_entry_id
  const showCheckbox = isBatchMode && isUncategorized
  const isDeletable = !transaction.journal_entry_id

  // Primary action: invoice/supplier-invoice match keeps the 1-click shortcut;
  // otherwise the user opens the template picker.
  const primaryAction = (() => {
    if (hasInvoiceMatch) {
      return (
        <Button
          size="sm"
          variant="default"
          className="h-9 px-3 text-sm"
          onClick={(e) => {
            e.stopPropagation()
            onOpenMatchDialog(transaction)
          }}
          disabled={isProcessing || isDisabled}
        >
          {isProcessing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('match_invoice_btn', {
            number: transaction.potential_invoice!.invoice_number ?? '',
          })}
        </Button>
      )
    }
    if (hasSupplierInvoiceMatch) {
      return (
        <Button
          size="sm"
          variant="default"
          className="h-9 px-3 text-sm"
          onClick={(e) => {
            e.stopPropagation()
            onOpenMatchDialog(transaction)
          }}
          disabled={isProcessing || isDisabled}
        >
          {isProcessing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('match_supplier_invoice_btn', {
            number: transaction.potential_supplier_invoice!.supplier_invoice_number ?? '',
          })}
        </Button>
      )
    }
    return (
      <Button
        size="sm"
        variant="default"
        className="h-9 px-3 text-sm"
        onClick={(e) => {
          e.stopPropagation()
          onOpenCategoryDialog(transaction)
        }}
        disabled={isProcessing || isDisabled}
      >
        Bokför
      </Button>
    )
  })()

  // Manual invoice-match affordance. Hidden once an auto-detected match is
  // already shown as the primary button — having both makes the row noisy.
  const showInvoiceMatchButton =
    isDeletable && !hasInvoiceMatch && !hasSupplierInvoiceMatch

  const invoiceMatchLabel = isIncome
    ? 'Matcha mot kundfaktura'
    : 'Matcha mot leverantörsfaktura'

  return (
    <motion.div
      layout
      initial={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, x: -16 }}
      transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      onAnimationComplete={(definition) => {
        if (typeof definition === 'object' && 'opacity' in definition && definition.opacity === 0) {
          onAnimationComplete?.(transaction.id)
        }
      }}
    >
      <DataListRow
        data-tx-id={transaction.id}
        selected={isSelected}
        className={cn(isDisabled && 'opacity-50')}
        rowClassName="py-4 gap-4"
        onClick={showCheckbox ? () => onToggleSelect(transaction.id) : undefined}
        leading={
          showCheckbox ? (
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect(transaction.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label="Välj transaktion"
            />
          ) : (
            <span
              className={cn(
                'inline-flex h-6 w-6 items-center justify-center',
                isIncome ? 'text-success' : 'text-foreground/60'
              )}
              aria-hidden
            >
              {isIncome ? (
                <ArrowUpRight className="h-5 w-5" />
              ) : (
                <ArrowDownRight className="h-5 w-5" />
              )}
            </span>
          )
        }
        trailing={
          <>
            <div className="text-right">
              <p
                className={cn(
                  'text-base font-medium tabular-nums leading-none',
                  isIncome && 'text-success'
                )}
              >
                {isIncome ? '+' : ''}
                {formatCurrency(transaction.amount, transaction.currency)}
              </p>
              {transaction.currency !== 'SEK' && transaction.amount_sek != null && (
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {formatCurrency(transaction.amount_sek)}
                </p>
              )}
            </div>
            {!isBatchMode && (
              <>
                {primaryAction}
                {showInvoiceMatchButton && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenMatchInvoicePicker(transaction)
                    }}
                    aria-label={invoiceMatchLabel}
                    title={invoiceMatchLabel}
                    disabled={isProcessing || isDisabled}
                  >
                    <Link2 className="h-4 w-4" />
                  </Button>
                )}
                {isDeletable && onDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(transaction.id)
                    }}
                    aria-label={t('delete_aria')}
                    disabled={isProcessing || isDisabled}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </>
            )}
          </>
        }
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <DataListPrimary className="text-base">{transaction.description}</DataListPrimary>
          <TransactionAttachmentIndicator documentId={transaction.document_id} />
        </div>
        <DataListMeta className="mt-1">
          <span className="tabular-nums">{formatDate(transaction.date)}</span>
          {skvCounterpartDate && (
            <>
              <DataListMetaSeparator />
              <Badge variant="warning" className="h-4 gap-1 px-1.5 py-0 text-[10px]">
                <AlertCircle className="h-3 w-3" />
                Möjlig 1930↔1630
              </Badge>
            </>
          )}
        </DataListMeta>
      </DataListRow>
    </motion.div>
  )
}
