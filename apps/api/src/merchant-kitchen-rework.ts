import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresKitchenReworkStore,
  KitchenReworkError,
  kitchenReworkPermission,
  parseKitchenReworkCommand,
  type KitchenReworkItem,
} from "@rms/kitchen";
import { kitchenPreparation, type KitchenPreparation } from "./merchant-kitchen-query.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const denied = (): never => {
  throw new KitchenReworkError("KITCHEN_REWORK_PERMISSION_DENIED");
};

function boundTransaction(transaction: {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
}): ConsumerTransaction {
  return {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      const result = await transaction.query(sql, values);
      if (!result || typeof result !== "object")
        throw new KitchenReworkError("KITCHEN_REWORK_UNAVAILABLE");
      const rows = Object.getOwnPropertyDescriptor(result, "rows");
      const count = Object.getOwnPropertyDescriptor(result, "rowCount");
      if (!rows || !("value" in rows) || !Array.isArray(rows.value))
        throw new KitchenReworkError("KITCHEN_REWORK_UNAVAILABLE");
      const rowCount = count && "value" in count ? (count.value as number | null) : null;
      return { rows: rows.value as readonly Row[], rowCount };
    },
  };
}

const displayName = (names: Readonly<Record<string, string>>) =>
  names["en-CA"] ?? names.en ?? Object.values(names)[0] ?? "Dish";

/** What staff see for one rework; no Actor identity beyond "you" and no internal codes in text. */
function reworkView(
  item: KitchenReworkItem,
  dish: {
    readonly localizedDisplayNames: Readonly<Record<string, string>>;
    readonly selectedOptions: readonly {
      readonly quantity: number;
      readonly localizedNames: Readonly<Record<string, string>>;
    }[];
  } | null,
  preparation: KitchenPreparation | undefined,
) {
  return Object.freeze({
    reworkReference: item.reworkReference,
    originalWorkItemReference: item.originalWorkItemReference,
    orderReference: item.orderReference,
    orderItemReference: item.orderItemReference,
    reasonCode: item.reasonCode,
    note: item.note,
    quantity: item.quantity,
    wasteApplies: item.wasteApplies,
    status: item.status,
    version: item.version,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    displayName: dish === null ? null : displayName(dish.localizedDisplayNames),
    selectedOptions:
      dish === null
        ? []
        : dish.selectedOptions.map((option) => ({
            displayName: displayName(option.localizedNames),
            quantity: option.quantity,
          })),
    orderLabel: preparation?.orderLabel ?? null,
    // WP-2423: the business day of the remade item's round, so a remake for an earlier day's
    // order is never mistaken for today's order with the same number.
    businessDate: preparation?.businessDate ?? null,
    customerNote: preparation?.customerNote ?? null,
    allergens: preparation?.allergens ?? { status: "Unavailable" as const },
  });
}

/**
 * WP-2423 Q26 (Handoff Section 26.6): the Kitchen board's remakes. Reading needs the Kitchen
 * board permission; creating a remake needs `kitchen.work_item.rework`, and starting or finishing
 * one needs the Kitchen board permission, each from a current named KDS operator Session. Scope,
 * Actor and time come from the session and server clock, never from the browser body.
 */
export function createMerchantKitchenRework(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return Object.freeze({
    async query(input: { sessionCookie: unknown; csrf: unknown }) {
      const session = await options.authentication.authorize(input);
      // WP-2423: one authorized run. The caller, `kitchen.operate` and (for a named operator) the
      // remake permission are resolved in one current-fact read at the start, and the caller is
      // re-checked in full before the reply, inside this transaction.
      return options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const scope = await resolveScope(
                transaction,
                input.sessionCookie,
                "kitchen.operate",
                session.sessionReference,
              );
              if (session.policy?.code !== "NamedKdsOperator") {
                if ((await scope.allowed()) !== true) return denied();
                return { scope, canRework: false };
              }
              const decisions = await scope.authorizeActions([
                "kitchen.operate",
                kitchenReworkPermission,
              ]);
              if (decisions.get("kitchen.operate")?.effect !== "Allow") return denied();
              return {
                scope,
                canRework: decisions.get(kitchenReworkPermission)?.effect === "Allow",
              };
            },
            recheck: async ({ scope }) => (await scope.allowed()) === true,
            denied,
          },
          async (run) => {
            const { scope, canRework } = run.scope;
            const authority = {
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.store.storeReference,
            };
            const tx = boundTransaction(transaction);
            const observedAt = options.persistence.now();
            const rows = await createPostgresKitchenReworkStore({
              ...authority,
              nextReference: options.nextReference,
            }).listCurrent(tx, observedAt);
            const preparation =
              rows.length === 0
                ? new Map<string, KitchenPreparation>()
                : await kitchenPreparation(
                    tx,
                    authority,
                    rows.map((row) => ({
                      workItemReference: row.item.originalWorkItemReference,
                      orderReference: row.item.orderReference,
                    })),
                  );
            return Object.freeze({
              storeReference: authority.storeReference,
              observedAt,
              canRework,
              items: rows.map((row) =>
                reworkView(row.item, row.dish, preparation.get(row.item.originalWorkItemReference)),
              ),
            });
          },
        ),
      );
    },
    async command(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
      const session = await options.authentication.authorize(input);
      if (session?.policy?.code !== "NamedKdsOperator") return denied();
      let command: ReturnType<typeof parseKitchenReworkCommand>;
      try {
        const action =
          input.command !== null && typeof input.command === "object"
            ? Object.getOwnPropertyDescriptor(input.command, "action")?.value
            : undefined;
        const browser = readClosedRecord(
          input.command,
          action === "CreateKitchenRework"
            ? [
                "action",
                "idempotencyKey",
                "originalWorkItemReference",
                "reasonCode",
                "note",
                "quantity",
                "correlationReference",
              ]
            : [
                "action",
                "idempotencyKey",
                "reworkReference",
                "expectedVersion",
                "correlationReference",
              ],
        );
        command = parseKitchenReworkCommand({ ...browser });
      } catch {
        throw new KitchenReworkError("KITCHEN_REWORK_INPUT_INVALID");
      }
      // WP-2423: the caller and the command's permission are resolved in full at the start and
      // re-checked in full before the commit, inside this transaction, so a withdrawn permission
      // or ended Session never commits the remake.
      return options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const scope = await resolveScope(
                transaction,
                input.sessionCookie,
                command.action === "CreateKitchenRework"
                  ? kitchenReworkPermission
                  : "kitchen.operate",
                session.sessionReference,
              );
              if ((await scope.allowed()) !== true) return denied();
              return scope;
            },
            recheck: async (scope) => (await scope.allowed()) === true,
            denied,
          },
          async ({ scope }) => {
            const result = await createPostgresKitchenReworkStore({
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.store.storeReference,
              nextReference: options.nextReference,
            }).execute(boundTransaction(transaction), {
              command,
              actorReference: scope.actorReference,
              occurredAt: options.persistence.now(),
            });
            return Object.freeze({
              status: result.status,
              action: result.action,
              rework: reworkView(result.item, null, undefined),
            });
          },
        ),
      );
    },
  });
}
