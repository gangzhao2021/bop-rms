import type { ConsumerTransaction } from "@bop/eventing";
import {
  readOrderExceptionProjection,
  type createPostgresOrderExceptionSourceStore,
  type OrderExceptionSource,
} from "@bop/projection";

export interface MerchantExceptionScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly sessionReference: string;
}

/**
 * WP-2423: what a payment reconciliation difference is about, for its Exceptions card. A business
 * day's totals carry the day, both sides' totals (the figures the day-end Settlement page shows
 * the same staff) and, once a later check of the day matched, when; never payment identifiers.
 */
export type MerchantExceptionReconciliationDetail =
  | {
      readonly type: "BusinessDayTotals";
      /** Null when the day could not be named (a settlement run outside the Store's schedule). */
      readonly businessDate: string | null;
      readonly captured: { readonly storeMinor: string; readonly providerMinor: string | null };
      readonly refunded: { readonly storeMinor: string; readonly providerMinor: string | null };
      readonly checkedAt: string;
      /** When a later check of the same day matched the payment provider's statement. */
      readonly resolvedAt: string | null;
    }
  | { readonly type: "Payment" }
  | { readonly type: "UnmatchedCharge" };

/** Authorized BFF read composition; trusted adapters must resolve session, scope and coverage.
 * Raw source digests, payment references and financial facts never enter the browser DTO, except
 * a business day's totals (see MerchantExceptionReconciliationDetail).
 */
export function createMerchantOrderExceptionRead(options: {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly sessionCookie: unknown;
      readonly permission: "operations.order-exception.manage";
    },
  ): Promise<MerchantExceptionScope | null>;
  sources(
    scope: MerchantExceptionScope,
  ): Pick<ReturnType<typeof createPostgresOrderExceptionSourceStore>, "list">;
  reconciliationAssigned?(
    tx: ConsumerTransaction,
    scope: MerchantExceptionScope,
    source: OrderExceptionSource,
  ): Promise<boolean>;
  /** WP-2423: the order numbers staff use for the linked Orders (this Store's only). */
  orderNumbers?(
    tx: ConsumerTransaction,
    scope: MerchantExceptionScope,
    orderReferences: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  /**
   * WP-2423: what each Payment reconciliation difference is about; a missing entry shows the
   * card without it. Never fails the page: an unreadable detail is left out.
   */
  reconciliationDetails?(
    tx: ConsumerTransaction,
    scope: MerchantExceptionScope,
    sources: readonly OrderExceptionSource[],
  ): Promise<ReadonlyMap<string, MerchantExceptionReconciliationDetail>>;
  metadata(
    tx: ConsumerTransaction,
    scope: MerchantExceptionScope,
    sources: readonly OrderExceptionSource[],
  ): Promise<{
    readonly currentSourceCheck?: "Complete";
    readonly storeLabel: string;
    readonly businessDate: string;
    readonly checkpointReference: string;
    readonly projectedAt: string;
    readonly freshnessStatus: "Fresh" | "Stale";
  }>;
}) {
  return async (sessionCookie: unknown) =>
    options.transactions
      .run(async (tx) => {
        const unavailable = (): never => {
          throw Error("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
        };
        const input = { sessionCookie, permission: "operations.order-exception.manage" as const };
        const scope = await options.authorize(tx, input);
        if (!scope) return unavailable();
        const sources = options.sources(scope);
        const items = [];
        let afterSourceReference: string | null = null;
        for (let page = 0; page < 5; page++) {
          const result = await sources.list(tx, { afterSourceReference, limit: 100 });
          items.push(...result.items);
          if (result.nextAfterSourceReference === null) break;
          if (
            afterSourceReference !== null &&
            result.nextAfterSourceReference <= afterSourceReference
          )
            return unavailable();
          afterSourceReference = result.nextAfterSourceReference;
          if (page === 4) return unavailable(); // Never present silently truncated operations coverage.
        }
        const metadata = await options.metadata(tx, scope, Object.freeze([...items]));
        if (
          typeof metadata.storeLabel !== "string" ||
          !/^[^\p{Cc}\p{Cf}]{1,100}$/u.test(metadata.storeLabel)
        )
          return unavailable();
        const projection = readOrderExceptionProjection({
          ...scope,
          ...metadata,
          sources: items,
          deriveProjectionReference: (source) => source,
        });
        const assignments = new Map<string, boolean>();
        for (const source of items) {
          if (
            source.kind === "PaymentReconciliationDifference" &&
            source.sourceOwner === "Payment" &&
            options.reconciliationAssigned
          ) {
            const assigned = await options.reconciliationAssigned(tx, scope, source);
            if (typeof assigned !== "boolean") return unavailable();
            assignments.set(source.sourceReference, assigned);
          }
        }
        const linked = [
          ...new Set(
            projection.rows.flatMap((row) =>
              row.orderReference === null ? [] : [row.orderReference],
            ),
          ),
        ];
        const numbers =
          options.orderNumbers && linked.length > 0
            ? await options.orderNumbers(tx, scope, linked)
            : new Map<string, string>();
        const reconciliationSources = items.filter(
          (source) =>
            source.kind === "PaymentReconciliationDifference" && source.sourceOwner === "Payment",
        );
        const details =
          options.reconciliationDetails && reconciliationSources.length > 0
            ? await options.reconciliationDetails(tx, scope, Object.freeze(reconciliationSources))
            : new Map<string, MerchantExceptionReconciliationDetail>();
        const current = await options.authorize(tx, input);
        if (
          !current ||
          current.tenantReference !== scope.tenantReference ||
          current.brandReference !== scope.brandReference ||
          current.storeReference !== scope.storeReference ||
          current.sessionReference !== scope.sessionReference
        )
          return unavailable();
        return Object.freeze({
          screenId: "OPS-ORDER-EXCEPTION" as const,
          projectionName: projection.projectionName,
          storeLabel: metadata.storeLabel,
          businessDate: projection.businessDate,
          projectedAt: projection.projectedAt,
          freshnessStatus: projection.freshnessStatus,
          items: Object.freeze(
            projection.rows.map((row) =>
              Object.freeze({
                exceptionReference: row.sourceReference,
                orderReference: row.orderReference,
                orderNumber:
                  row.orderReference === null ? null : (numbers.get(row.orderReference) ?? null),
                kind: row.kind,
                severity: row.severity,
                status: row.status,
                providerState: row.providerState,
                compensationStatus: row.compensationStatus,
                sourceOwner: row.sourceOwner,
                createdAt: row.createdAt,
                dueAt: row.dueAt,
                ownerStatus:
                  (assignments.get(row.sourceReference) ?? row.ownerReference !== null)
                    ? ("Assigned" as const)
                    : ("Unassigned" as const),
                sourceFinal: row.sourceStatus === "Final",
                ...(row.kind === "PaymentReconciliationDifference" &&
                row.sourceOwner === "Payment" &&
                details.has(row.sourceReference)
                  ? { reconciliation: details.get(row.sourceReference) }
                  : {}),
              }),
            ),
          ),
        });
      })
      .catch(() => {
        throw Error("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
      });
}
