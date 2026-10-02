import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createKitchenWorkLifecycleService,
  createPostgresKitchenWorkLifecycleStore,
  KitchenWorkLifecycleError,
  parseKitchenWorkLifecycleCommand,
  type KitchenWorkLifecyclePorts,
} from "@rms/kitchen";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type StoreOptions = Parameters<typeof createPostgresKitchenWorkLifecycleStore>[0];

/** Current Workforce scope gates both new execution and idempotent recovery. */
export function createMerchantKitchenCommand(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  lifecycle: Pick<
    KitchenWorkLifecyclePorts,
    "admission" | "expo" | "references" | "digests" | "tenantContext" | "idempotency"
  >;
  validateCurrentSource: StoreOptions["validateCurrentSource"];
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    if (session?.policy?.code !== "NamedKdsOperator")
      throw new KitchenWorkLifecycleError("KITCHEN_WORK_PERMISSION_DENIED");
    return options.persistence.transactions.run(async (transaction) => {
      const scope = await resolveScope(
        transaction,
        input.sessionCookie,
        "kitchen.operate",
        session.sessionReference,
      );
      let commandValue = input.command;
      if (
        commandValue &&
        typeof commandValue === "object" &&
        Object.hasOwn(commandValue, "authority")
      ) {
        try {
          const actionDescriptor = Object.getOwnPropertyDescriptor(commandValue, "action");
          const action =
            actionDescriptor && "value" in actionDescriptor ? actionDescriptor.value : null;
          const fields = [
            "authority",
            "action",
            "idempotencyKey",
            "storeReference",
            "ticketReference",
            "orderItemReference",
            "expectedTicketVersion",
            "correlationReference",
            ...(action === "MarkKitchenOrderItemReady"
              ? ["workItems"]
              : ["workItemReference", "expectedWorkItemVersion"]),
            ...(action === "CompleteKitchenWorkItem" ? ["quantityDelta"] : []),
          ];
          const browser = readClosedRecord(commandValue, fields);
          if (browser.authority !== "CurrentMerchantSession") throw new Error("invalid authority");
          commandValue = Object.fromEntries(
            Object.entries(browser).filter(([key]) => key !== "authority"),
          );
          commandValue = {
            ...(commandValue as Record<string, unknown>),
            actorReference: scope.actorReference,
            brandReference: scope.context.brand.brandReference,
          };
        } catch {
          throw new KitchenWorkLifecycleError("KITCHEN_WORK_INPUT_INVALID");
        }
      }
      const command = parseKitchenWorkLifecycleCommand(commandValue);
      const matches = (value: {
        actorReference: string;
        brandReference: string;
        storeReference: string;
      }) =>
        value.actorReference === scope.actorReference &&
        value.brandReference === scope.context.brand.brandReference &&
        value.storeReference === scope.store.storeReference;
      if (!matches(command) || !(await scope.allowed()))
        throw new KitchenWorkLifecycleError("KITCHEN_WORK_PERMISSION_DENIED");
      const observedAt = options.persistence.now();
      const tx: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object")
            throw new KitchenWorkLifecycleError("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          const count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
          )
            throw new KitchenWorkLifecycleError("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };
      return createKitchenWorkLifecycleService({
        ...options.lifecycle,
        trustedContext: {
          resolveAuthority: async () => ({
            actorReference: scope.actorReference,
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.store.storeReference,
            observedAt,
          }),
        },
        correlationContext: {
          resolve: async () => ({ correlationReference: command.correlationReference }),
        },
        authorization: {
          authorize: async (candidate) => matches(candidate) && (await scope.allowed()),
        },
        transactions: { withTransaction: async (work) => work(tx) },
        clock: { now: () => observedAt },
        repository: createPostgresKitchenWorkLifecycleStore({
          ...options.lifecycle,
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.store.storeReference,
          authorize: async (_tx, candidate) =>
            (candidate.access === "Recover" || matches(candidate.command)) &&
            (await scope.allowed()),
          validateCurrentSource: options.validateCurrentSource,
        }),
      }).execute(command);
    });
  };
}
