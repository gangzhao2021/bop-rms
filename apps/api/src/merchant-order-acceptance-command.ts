import { createMerchantPaidAdditionalOrderAcceptance } from "./merchant-paid-additional-order-acceptance.js";
import type { ConsumerTransaction } from "@bop/eventing";
import type { AppendAuditRecordInput } from "@bop/audit";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
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
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const keys = [
      "acceptanceReference",
      "operationReference",
      "orderReference",
      "orderBatchReference",
    ] as const;
    const raw = readClosedRecord(input.command, [...keys, "expectedOrderVersion"]);
    const references = Object.fromEntries(
      keys.map((key) => [key, String(parseOpaqueUuidV7(raw[key], "ACTOR_REFERENCE_INVALID"))]),
    ) as Record<(typeof keys)[number], string>;
    if (
      typeof raw.expectedOrderVersion !== "number" ||
      !Number.isInteger(raw.expectedOrderVersion) ||
      raw.expectedOrderVersion < 1 ||
      raw.expectedOrderVersion >= 2147483647
    )
      throw new Error("ORDER_ACCEPTANCE_COMMAND_INVALID");
    const command = Object.freeze({
      ...references,
      expectedOrderVersion: raw.expectedOrderVersion,
    });
    return options.persistence.transactions.run(async (transaction) => {
      const { selected, context, store, actorReference, allowed } = await resolveScope(
        transaction,
        input.sessionCookie,
        "order.accept",
        authenticated.sessionReference,
      );
      const deny = (): never => {
        throw new Error("ORDER_ACCEPTANCE_COMMAND_DENIED");
      };
      if ((await allowed()) !== true) return deny();
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
      const resolved = await options.resolveConfiguration(
        businessTransaction,
        {
          ...scope,
          actorReference: String(actorReference),
        },
        command,
      );
      if (resolved.configuration.acceptance.permissionCode !== "order.accept") return deny();
      const security: Pick<
        Composition,
        "scope" | "actorReference" | "authorizeActor" | "authorize" | "audit"
      > = {
        scope,
        actorReference: String(actorReference),
        authorizeActor: async () => (await allowed()) === true,
        authorize: async (_tx, candidate) =>
          String(candidate.actorReference) === String(actorReference) &&
          candidate.brandReference === scope.brandReference &&
          candidate.storeReference === scope.storeReference &&
          candidate.orderReference === command.orderReference &&
          candidate.orderBatchReference === command.orderBatchReference &&
          (await allowed()) === true,
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
          ? createMerchantPaidAdditionalOrderAcceptance({ ...resolved.configuration, ...security })
          : createMerchantPaidOrderAcceptance({ ...resolved.configuration, ...security });
      const result = await runtime.commit({
        transaction: businessTransaction,
        command,
        paymentEvent: resolved.paymentEvent,
      });
      if ((await allowed()) !== true) return deny();
      return { status: result.status, acceptedOrderVersion: result.record.acceptedOrderVersion };
    });
  };
}
