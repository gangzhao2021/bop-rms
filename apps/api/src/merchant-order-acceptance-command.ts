import { createMerchantPaidAdditionalOrderAcceptance } from "./merchant-paid-additional-order-acceptance.js";
import type { ConsumerTransaction } from "@bop/eventing";
import type { AppendAuditRecordInput } from "@bop/audit";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import { OrderAcceptanceRecordError } from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantPaidOrderAcceptance } from "./merchant-paid-order-acceptance.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

type Composition = Parameters<typeof createMerchantPaidOrderAcceptance>[0];
type AdditionalComposition = Parameters<typeof createMerchantPaidAdditionalOrderAcceptance>[0];
type ServerConfiguration<T> = Omit<
  T,
  "scope" | "actorReference" | "authorizeActor" | "authorize" | "audit"
>;
type Command = Readonly<{
  acceptanceReference: string;
  operationReference: string;
  orderReference: string;
  orderBatchReference: string;
  expectedOrderVersion: number;
}>;

export const merchantOrderAcceptanceErrorCodes = [
  "ORDER_ACCEPTANCE_VERSION_CONFLICT",
  "ORDER_ACCEPTANCE_ALREADY_ACCEPTED",
  "ORDER_ACCEPTANCE_NOT_ACCEPTABLE",
] as const;
/**
 * WP-2423: why an authorized acceptance did not happen, so staff are told in plain words (the order
 * changed, someone already accepted it, or it can no longer be accepted as it is) instead of a
 * permission refusal. Raised only after the staff member's authority was confirmed.
 */
export class MerchantOrderAcceptanceError extends Error {
  readonly code: (typeof merchantOrderAcceptanceErrorCodes)[number];
  constructor(code: MerchantOrderAcceptanceError["code"]) {
    super("order acceptance did not happen");
    this.name = "MerchantOrderAcceptanceError";
    this.code = code;
  }
}

/**
 * How the expected Order version is chosen: the version the staff member saw (Orders page), or —
 * for a server-side acceptance right after staff recorded a card-machine payment — the version
 * the Order is at now, read from the same paid context the acceptance checks.
 */
export type MerchantOrderAcceptanceMode = "SeenVersion" | "CurrentVersion";

/** Authenticated batch acceptance; identity, Audit and Payment evidence are server-owned. */
export function createMerchantOrderAcceptanceCommand(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration(
    transaction: ConsumerTransaction,
    scope: Composition["scope"] & { actorReference: string },
    command: Command,
  ): Promise<
    | { kind?: "Initial"; configuration: ServerConfiguration<Composition>; paymentEvent: unknown }
    | {
        kind: "Additional";
        configuration: ServerConfiguration<AdditionalComposition>;
        paymentEvent: unknown;
      }
  >;
  generateAuditReference(): string;
  audit: Pick<AppendAuditRecordInput, "retentionPolicyCode" | "retentionPolicyVersion">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (
    input: { sessionCookie: unknown; csrf: unknown; command: unknown },
    mode: MerchantOrderAcceptanceMode = "SeenVersion",
  ): Promise<{ status: "Created" | "AlreadyCommitted"; acceptedOrderVersion: number }> => {
    const authenticated = await options.authentication.authorize(input);
    const keys = [
      "acceptanceReference",
      "operationReference",
      "orderReference",
      "orderBatchReference",
    ] as const;
    const raw = readClosedRecord(
      input.command,
      mode === "CurrentVersion" ? [...keys] : [...keys, "expectedOrderVersion"],
    );
    const references = Object.fromEntries(
      keys.map((key) => [key, String(parseOpaqueUuidV7(raw[key], "ACTOR_REFERENCE_INVALID"))]),
    ) as Record<(typeof keys)[number], string>;
    if (
      mode !== "CurrentVersion" &&
      (typeof raw.expectedOrderVersion !== "number" ||
        !Number.isInteger(raw.expectedOrderVersion) ||
        raw.expectedOrderVersion < 1 ||
        raw.expectedOrderVersion >= 2147483647)
    )
      throw new Error("ORDER_ACCEPTANCE_COMMAND_INVALID");
    // The configuration resolver sees the batch named; a server-side acceptance has no version yet.
    const named = Object.freeze({
      ...references,
      expectedOrderVersion: mode === "CurrentVersion" ? 1 : (raw.expectedOrderVersion as number),
    });
    const deny = (): never => {
      throw new Error("ORDER_ACCEPTANCE_COMMAND_DENIED");
    };
    // WP-2423: one authorized run. The staff member and `order.accept` are resolved in full once
    // at the start and once more before the commit (inside this transaction: a permission
    // withdrawn or a Session ended meanwhile accepts nothing). The acceptance runtime's owner
    // checks in between (several per acceptance, some while the Order and payment-disposition
    // locks are held) take the run's no-query guard instead of re-resolving the caller.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const current = await resolveScope(
              transaction,
              input.sessionCookie,
              "order.accept",
              authenticated.sessionReference,
            );
            if ((await current.allowed()) !== true) return deny();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied: deny,
        },
        async (authority) => {
          const { selected, context, store, actorReference } = authority.scope;
          const allowed = () => authority.guard();
          const businessTransaction: ConsumerTransaction = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await transaction.query(sql, values);
              if (!result || typeof result !== "object")
                throw new Error("ORDER_ACCEPTANCE_COMMAND_UNAVAILABLE");
              const rows = Object.getOwnPropertyDescriptor(result, "rows");
              const count = Object.getOwnPropertyDescriptor(result, "rowCount");
              if (
                !rows ||
                !("value" in rows) ||
                !Array.isArray(rows.value) ||
                !count ||
                !("value" in count) ||
                (count.value !== null &&
                  (typeof count.value !== "number" ||
                    !Number.isSafeInteger(count.value) ||
                    count.value < 0))
              )
                throw new Error("ORDER_ACCEPTANCE_COMMAND_UNAVAILABLE");
              return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
            },
          };

          const scope = {
            tenantReference: selected.tenantReference,
            brandReference: String(context.brand.brandReference),
            storeReference: String(store.storeReference),
          };
          type Named = typeof named;
          /** The server-resolved configuration and runtime for one command (its version included:
           * the published-policy gates check the version the command names). */
          const build = async (candidate: Named) => {
            const resolved = await options.resolveConfiguration(
              businessTransaction,
              {
                ...scope,
                actorReference: String(actorReference),
              },
              candidate,
            );
            if (resolved.configuration.acceptance.permissionCode !== "order.accept") return deny();
            const security: Pick<
              Composition,
              "scope" | "actorReference" | "authorizeActor" | "authorize" | "audit"
            > = {
              scope,
              actorReference: String(actorReference),
              authorizeActor: async () => (await allowed()) === true,
              authorize: async (_tx, record) =>
                (await authority.guard()) &&
                String(record.actorReference) === String(actorReference) &&
                record.brandReference === scope.brandReference &&
                record.storeReference === scope.storeReference &&
                record.orderReference === candidate.orderReference &&
                record.orderBatchReference === candidate.orderBatchReference,
              audit: async (fact) => ({
                ...options.audit,
                auditId: options.generateAuditReference(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "User", reference: actorReference },
                actionCode: "ORDER_ACCEPTED",
                targetType: "Order",
                targetId: fact.orderReference,
                correlationId: fact.operationReference,
                reasonCode: fact.reasonCode,
                occurredAt: fact.acceptedAt,
                sourceChannel: "MERCHANT_WEB",
                afterSummary: { phase: "Accepted" },
                dataClassification: "Restricted",
              }),
            };
            const runtime =
              resolved.kind === "Additional"
                ? createMerchantPaidAdditionalOrderAcceptance({
                    ...resolved.configuration,
                    ...security,
                  })
                : createMerchantPaidOrderAcceptance({ ...resolved.configuration, ...security });
            return { resolved, runtime };
          };
          let built = await build(named);
          // The Order as it is now: a table Order's version moves with every round, so a stale
          // version is a conflict to refresh, and an acceptance by someone else is reported as such.
          const current = await built.runtime.current({
            transaction: businessTransaction,
            paymentEvent: built.resolved.paymentEvent,
          });
          const replay =
            current.acceptance !== null &&
            current.acceptance.acceptanceReference === named.acceptanceReference &&
            current.acceptance.operationReference === named.operationReference;
          if (current.acceptance !== null && !replay) {
            if (mode === "CurrentVersion")
              return {
                status: "AlreadyCommitted" as const,
                acceptedOrderVersion: current.acceptance.acceptedOrderVersion,
              };
            throw new MerchantOrderAcceptanceError("ORDER_ACCEPTANCE_ALREADY_ACCEPTED");
          }
          const expectedOrderVersion =
            current.acceptance !== null
              ? current.acceptance.acceptedOrderVersion - 1
              : mode === "CurrentVersion"
                ? current.orderVersion
                : named.expectedOrderVersion;
          if (mode === "SeenVersion" && expectedOrderVersion !== named.expectedOrderVersion)
            throw new MerchantOrderAcceptanceError("ORDER_ACCEPTANCE_VERSION_CONFLICT");
          if (current.acceptance === null && expectedOrderVersion !== current.orderVersion)
            throw new MerchantOrderAcceptanceError("ORDER_ACCEPTANCE_VERSION_CONFLICT");
          const command: Named = Object.freeze({ ...references, expectedOrderVersion });
          if (command.expectedOrderVersion !== named.expectedOrderVersion)
            built = await build(command);
          const result = await built.runtime
            .commit({
              transaction: businessTransaction,
              command,
              paymentEvent: built.resolved.paymentEvent,
            })
            .catch((error: unknown) => {
              // Authority was confirmed above: the batch can no longer be accepted as it is (its
              // payment or acceptance time passed, stock changed, or it was cancelled).
              if (error instanceof OrderAcceptanceRecordError)
                throw new MerchantOrderAcceptanceError("ORDER_ACCEPTANCE_NOT_ACCEPTABLE");
              throw error;
            });
          return {
            status: result.status,
            acceptedOrderVersion: result.record.acceptedOrderVersion,
          };
        },
      ),
    );
  };
}
