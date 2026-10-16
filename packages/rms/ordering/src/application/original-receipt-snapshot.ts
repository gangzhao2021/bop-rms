import { parseReceiptOrderSnapshot } from "../domain/receipt-order-snapshot.js";
import {
  parseConfiguredOrderCreationRecord,
  parseOrderCreationRecord,
} from "../domain/order-creation.js";
import {
  DigitalReceiptError,
  parseDigitalReceiptSnapshot,
  type DigitalReceiptSnapshot,
  type ReceiptBusinessAddress,
  type ReceiptMoney,
  type ReceiptTaxLine,
  type ReceiptTaxRegistration,
} from "../domain/digital-receipt.js";
import type { OrderTaxComponentSnapshot } from "../domain/order-item-snapshot.js";

/** "0.13" → "13", "0.09975" → "9.975": the frozen decimal rate as a percent, by digit shift. */
export function receiptRatePercent(rate: string): string {
  if (!/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{0,12})?$/u.test(rate))
    throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
  const [whole = "0", fraction = ""] = rate.split(".");
  const padded = fraction.padEnd(2, "0");
  const integer = (whole + padded.slice(0, 2)).replace(/^0+(?=[0-9])/u, "");
  const rest = padded.slice(2).replace(/0+$/u, "");
  return rest === "" ? integer : integer + "." + rest;
}

/**
 * WP-2423 Q15: one receipt line per tax type and rate (and whether it was included in prices),
 * summed from the order items' frozen tax components; exempt and zero-rated parts print no line.
 */
export function receiptTaxLines(
  components: readonly OrderTaxComponentSnapshot[],
  currencyCode: string,
): readonly ReceiptTaxLine[] {
  const lines = new Map<string, { line: ReceiptTaxLine; order: number }>();
  for (const component of components) {
    if (component.treatment !== "Taxable") continue;
    if (component.taxAmount.currencyCode !== currencyCode)
      throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
    const label = component.taxComponentCode.replaceAll("_", " ");
    const ratePercent = receiptRatePercent(component.rate);
    const included = component.priceInclusion === "Inclusive";
    const key = label + "|" + ratePercent + "|" + String(included);
    const prior = lines.get(key);
    lines.set(key, {
      order: Math.min(prior?.order ?? component.calculationOrder, component.calculationOrder),
      line: Object.freeze({
        label,
        ratePercent,
        included,
        amount: Object.freeze({
          amountMinor: (prior?.line.amount.amountMinor ?? 0n) + component.taxAmount.amountMinor,
          currencyCode,
        }),
      }),
    });
  }
  return Object.freeze(
    [...lines.values()]
      .sort((a, b) => a.order - b.order || (a.line.label < b.line.label ? -1 : 1))
      .map((entry) => entry.line),
  );
}

export interface OriginalReceiptSources {
  readonly order: unknown;
  readonly orderSnapshotVersion: 1 | 2;
  readonly receiptReference: string;
  readonly issuedAt: string;
  readonly issuer: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly operatingEntityReference: string;
    readonly displayName: string;
  };
  readonly store: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly displayName: string;
    readonly currencyCode: string;
  };
  readonly template: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly version: string;
    readonly locale: string;
    /** WP-2423: the exact published template version (recorded on the receipt when given). */
    readonly versionReference?: string;
  };
  readonly financial: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly orderReference: string;
    readonly orderBatchReferences: readonly string[];
    readonly captured: ReceiptMoney;
    readonly tip: ReceiptMoney;
    readonly refunded: ReceiptMoney;
    readonly refundDisposition: "NonePending" | "Pending";
  };
  /**
   * WP-2423 Q15: the Store's published address and the registrations its Owner entered, read at
   * issue under the caller's fences. Omitted only by callers that predate Q15.
   */
  readonly receiptDetails?: {
    readonly businessAddress: ReceiptBusinessAddress | null;
    readonly taxRegistrations: readonly ReceiptTaxRegistration[];
  };
}

/**
 * Assemble frozen facts, not authorization. The caller resolves current complete Order,
 * issuer/template and financial/refund evidence under owner fences held through append.
 * An old creation record alone does not establish coverage of later-added Order batches.
 */
export function createOriginalReceiptSnapshotFromOrder(
  input: OriginalReceiptSources,
): DigitalReceiptSnapshot {
  const fail = (): never => {
    throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
  };
  try {
    if (input.orderSnapshotVersion !== 1 && input.orderSnapshotVersion !== 2) return fail();
    const record =
      input.orderSnapshotVersion === 2
        ? parseConfiguredOrderCreationRecord(input.order)
        : parseOrderCreationRecord(input.order);
    return createOriginalReceiptSnapshotFromCurrentOrder({
      ...input,
      order: {
        orderReference: record.order.orderReference,
        brandReference: record.order.brandReference,
        storeReference: record.order.storeReference,
        guestSessionReference: record.guestSessionReference,
        orderNumber: record.orderNumberAllocation.orderNumber,
        createdAt: record.createdAt,
        batches: record.order.batches.map((batch) => ({
          orderBatchReference: batch.orderBatchReference,
          submittedAt: batch.submittedAt,
        })),
        items: record.items.map((snapshot) => ({
          snapshotVersion: input.orderSnapshotVersion,
          snapshot,
        })),
      },
    });
  } catch {
    return fail();
  }
}

export type CurrentOrderReceiptSources = Omit<OriginalReceiptSources, "orderSnapshotVersion">;

/** Assemble all frozen batch lines; callers must establish current complete coverage. */
export function createOriginalReceiptSnapshotFromCurrentOrder(
  input: CurrentOrderReceiptSources,
): DigitalReceiptSnapshot {
  const fail = (): never => {
    throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
  };
  try {
    const order = parseReceiptOrderSnapshot(input.order);
    const items = order.items.map((item) => item.snapshot);
    const financial = input.financial;
    if (
      [input.issuer, input.store, input.template, financial].some(
        (source) =>
          source.brandReference !== order.brandReference ||
          source.storeReference !== order.storeReference,
      ) ||
      financial.orderReference !== order.orderReference ||
      !Array.isArray(financial.orderBatchReferences) ||
      financial.orderBatchReferences.length !== order.batches.length ||
      new Set(financial.orderBatchReferences).size !== order.batches.length ||
      order.batches.some(
        (batch) => !financial.orderBatchReferences.includes(batch.orderBatchReference),
      ) ||
      !["NonePending", "Pending"].includes(financial.refundDisposition)
    )
      return fail();
    const currencyCode = input.store.currencyCode;
    const sum = (field: "subtotal" | "discount" | "fee" | "tax" | "total"): ReceiptMoney => ({
      amountMinor: items.reduce((amount, item) => {
        if (item.pricing[field].currencyCode !== currencyCode) return fail();
        return amount + item.pricing[field].amountMinor;
      }, 0n),
      currencyCode,
    });
    if (sum("total").amountMinor + financial.tip.amountMinor !== financial.captured.amountMinor)
      return fail();
    const paymentStatus =
      financial.refundDisposition === "Pending"
        ? "RefundPending"
        : financial.refunded.amountMinor === 0n
          ? "Paid"
          : financial.refunded.amountMinor === financial.captured.amountMinor
            ? "Refunded"
            : "PartiallyRefunded";
    const snapshot = parseDigitalReceiptSnapshot({
      receiptReference: input.receiptReference,
      orderReference: order.orderReference,
      guestSessionReference: order.guestSessionReference,
      operatingEntityReference: input.issuer.operatingEntityReference,
      operatingEntityDisplayName: input.issuer.displayName,
      brandReference: order.brandReference,
      storeReference: order.storeReference,
      storeDisplayName: input.store.displayName,
      orderNumber: order.orderNumber,
      issuedAt: input.issuedAt,
      locale: input.template.locale,
      templateVersion: input.template.version,
      ...(input.template.versionReference === undefined
        ? {}
        : { templateVersionReference: input.template.versionReference }),
      lines: items.map((item) => ({
        lineReference: item.orderItemReference,
        displayName: item.catalog.localizedNames[input.template.locale],
        quantity: item.quantity,
        lineTotal: item.pricing.total,
        // WP-2423 D5: print the item's price before tax; tax is listed after the subtotal.
        lineSubtotal: item.pricing.subtotal,
      })),
      subtotal: sum("subtotal"),
      adjustments: { discount: sum("discount"), fee: sum("fee") },
      tax: sum("tax"),
      ...(input.receiptDetails === undefined
        ? {}
        : {
            taxDetails: {
              businessAddress: input.receiptDetails.businessAddress,
              taxRegistrations: input.receiptDetails.taxRegistrations,
              taxLines: receiptTaxLines(
                items.flatMap((item) => item.pricing.taxComponents),
                currencyCode,
              ),
              paymentMethod: "Card",
            },
          }),
      tip: financial.tip,
      total: financial.captured,
      refundedTotal: financial.refunded,
      paymentStatus,
    });
    if (
      snapshot.issuedAt < order.createdAt ||
      order.batches.some((batch) => snapshot.issuedAt < batch.submittedAt)
    )
      return fail();
    return snapshot;
  } catch {
    return fail();
  }
}
