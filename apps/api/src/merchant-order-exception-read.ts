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

/** Authorized BFF read composition; trusted adapters must resolve session, scope and coverage.
 * Raw source digests, payment references and financial facts never enter the browser DTO.
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
              }),
            ),
          ),
        });
      })
      .catch(() => {
        throw Error("MERCHANT_ORDER_EXCEPTION_UNAVAILABLE");
      });
}
