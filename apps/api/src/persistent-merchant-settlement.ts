import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrdinaryRefundWindowSource,
  createPostgresPaymentCaptureWindowSource,
  createPostgresPaymentReconciliationWindowSource,
} from "@rms/payment";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreBusinessDateConfigurationSource,
  resolveClosedStoreBusinessDateWindow,
  resolveStoreBusinessDate,
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createMerchantSettlementRead,
  type MerchantSettlementScope,
  type MerchantSettlementWindow,
} from "./merchant-settlement-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const unavailable = (): never => {
  throw new Error("MERCHANT_SETTLEMENT_UNAVAILABLE");
};
const matches = (a: MerchantSettlementScope, b: MerchantSettlementScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference &&
  a.sessionReference === b.sessionReference;

/**
 * WP-2423 P1: the day-end settlement read over the owner sources. The session's selected Store
 * is resolved in the same transaction as every read, under the exception-handling permission the
 * pilot gives Store Managers; Provider facts stay in Payment and only day totals leave.
 */
export function createPersistentMerchantSettlement(options: {
  persistence: PersistentMerchantBffOptions;
  /** The Provider account and environment whose captures and refunds this Store settles. */
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: MerchantSettlementScope,
  ): Promise<{ readonly providerAccountReference: string; readonly environment: "Test" | "Live" }>;
}) {
  const persistence = options.persistence,
    resolve = createMerchantStoreScope(persistence);
  return async (input: {
    readonly sessionCookie: unknown;
    readonly businessDate: string | null;
  }) => {
    type Original = Parameters<Parameters<typeof persistence.transactions.run>[0]>[0];
    const originals = new Map<ConsumerTransaction, Original>();
    const stores = new Map<ConsumerTransaction, { displayName: string; timeZone: string }>();
    const current = async (tx: ConsumerTransaction) => {
      const original = originals.get(tx);
      if (!original) return unavailable();
      const value = await resolve(
        original,
        input.sessionCookie,
        "operations.order-exception.manage",
      );
      if (!(await value.allowed())) return unavailable();
      return value;
    };
    const authorize = async (tx: ConsumerTransaction): Promise<MerchantSettlementScope> => {
      const value = await current(tx);
      stores.set(tx, { displayName: value.store.displayName, timeZone: value.store.timeZone });
      return Object.freeze({
        tenantReference: value.selected.tenantReference,
        brandReference: String(value.context.brand.brandReference),
        storeReference: String(value.store.storeReference),
        sessionReference: String(value.sessionReference),
      });
    };
    const guard = (scope: MerchantSettlementScope) => async (tx: ConsumerTransaction) =>
      matches(await authorize(tx), scope);
    const transactions = {
      run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) =>
        persistence.transactions.run(async (original) => {
          const tx: ConsumerTransaction = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await original.query(sql, values);
              if (!result || typeof result !== "object") return unavailable();
              const rows = Object.getOwnPropertyDescriptor(result, "rows"),
                count = Object.getOwnPropertyDescriptor(result, "rowCount");
              if (
                !rows ||
                !("value" in rows) ||
                !Array.isArray(rows.value) ||
                !count ||
                !("value" in count) ||
                (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
              )
                return unavailable();
              return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
            },
          };
          originals.set(tx, original);
          try {
            return await work(tx);
          } finally {
            originals.delete(tx);
            stores.delete(tx);
          }
        }),
    };
    const configurationSource = (tx: ConsumerTransaction, scope: MerchantSettlementScope) => {
      const store = stores.get(tx) ?? unavailable();
      return createPostgresStoreBusinessDateConfigurationSource({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        timeZone: store.timeZone,
        authorize: async (t) => guard(scope)(t as ConsumerTransaction),
        publicationProof: async (t, candidate, at) => {
          const proof = await createPostgresCurrentStorePublicationProof({
            ...persistence.publication,
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            authorize: async () => guard(scope)(t as ConsumerTransaction),
            configurationReference: candidate.configurationReference,
            hashContent: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
          })(t, at);
          return {
            contentDigest: proof.contentDigest,
            businessDayStartSource: proof.businessDayStartSource,
          };
        },
      });
    };
    /** Owner reads answer null when their source cannot; our own scope refusal still propagates. */
    const optional = async <T>(work: () => Promise<T>): Promise<T | null> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof Error && error.message === "MERCHANT_SETTLEMENT_UNAVAILABLE")
          throw error;
        return null;
      }
    };
    const read = createMerchantSettlementRead({
      transactions,
      authorize: async (tx) => authorize(tx),
      storeLabel: async (tx) => (stores.get(tx) ?? unavailable()).displayName,
      now: () => persistence.now(),
      window: async (tx, scope, businessDate): Promise<MerchantSettlementWindow> => {
        const now = persistence.now();
        const source = configurationSource(tx, scope);
        const today = resolveStoreBusinessDate({
          occurredAt: now,
          configuration: await source(tx, now),
        });
        const currentDate = String(today.businessDate);
        if (businessDate === currentDate)
          return {
            businessDate: currentDate,
            startsAt: String(today.businessDateBoundaryAt),
            endsAt: now,
            timeZone: today.timeZone,
            status: "Open",
          };
        if (businessDate !== null && businessDate > currentDate) return unavailable();
        let date = businessDate;
        if (date === null) {
          const priorAt = new Date(
            Date.parse(String(today.businessDateBoundaryAt)) - 1,
          ).toISOString();
          date = String(
            resolveStoreBusinessDate({
              occurredAt: priorAt,
              configuration: await source(tx, priorAt),
            }).businessDate,
          );
        }
        // The configuration in force on that day; UTC noon lies inside every Store's business day.
        const window = resolveClosedStoreBusinessDateWindow({
          businessDate: date,
          observedAt: now,
          configuration: await source(tx, `${date}T12:00:00.000Z`),
        });
        return {
          businessDate: String(window.businessDate),
          startsAt: String(window.startsAt),
          endsAt: String(window.endsAt),
          timeZone: window.timeZone,
          status: "Closed",
        };
      },
      captured: (tx, scope, window) =>
        optional(async () => {
          const configuration = await options.resolveConfiguration(tx, scope);
          const result = await createPostgresPaymentCaptureWindowSource({
            scope: {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              providerAccountReference: configuration.providerAccountReference,
              environment: configuration.environment,
            },
            authorize: async (t) => guard(scope)(t),
          })(tx, {
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            observedAt: persistence.now(),
          });
          return {
            count: result.captureCount,
            amountMinor: result.capturedAmountMinor.toString(),
            currencyCode: "CAD" as const,
          };
        }),
      refunded: (tx, scope, window) =>
        optional(async () => {
          const configuration = await options.resolveConfiguration(tx, scope);
          const result = await createPostgresOrdinaryRefundWindowSource({
            scope: {
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              providerAccountReference: configuration.providerAccountReference,
              environment: configuration.environment,
            },
            authorize: async (t) => guard(scope)(t),
          })(tx, {
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            observedAt: persistence.now(),
          });
          return {
            count: result.refundCount,
            amountMinor: result.refundedAmountMinor.toString(),
            currencyCode: "CAD" as const,
          };
        }),
      reconciliation: (tx, scope, window) =>
        optional(async () => {
          const result = await createPostgresPaymentReconciliationWindowSource({
            scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
            authorize: async (t) => guard(scope)(t),
          })(tx, { startsAt: window.startsAt, endsAt: window.endsAt });
          return { runs: result.runs, differences: result.differences };
        }),
    });
    return read(input);
  };
}
