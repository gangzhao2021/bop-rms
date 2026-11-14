import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { loadKitchenWorkItemChoices } from "@rms/kitchen";
import {
  createPostgresMerchantOrderIndex,
  loadMerchantOrderLines,
  parseOrderingReference,
} from "@rms/ordering";
import { markDiningComboPartServed, markKitchenComboPartDone } from "./merchant-combo-parts.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (coordinator 2026-10-28 decision 3): the kitchen
 * marks one dish of a combo done (the named KDS operator, kitchen.operate), and a server marks one
 * dish of a combo served at its table (dining.item.serve) once the kitchen made it. Each answers
 * whether every dish is done (served) now; the page then finishes (serves) the combo with the
 * existing command. A retry of the same operation records nothing again.
 */
export class MerchantComboPartError extends Error {
  constructor(
    readonly code: "PermissionDenied" | "NotFound" | "Invalid" | "NotReady" | "Conflict",
  ) {
    super(code);
    this.name = "MerchantComboPartError";
  }
}
const fail = (code: MerchantComboPartError["code"]): never => {
  throw new MerchantComboPartError(code);
};
const reference = (value: unknown): string => {
  try {
    return String(parseOrderingReference(value));
  } catch {
    return fail("Invalid");
  }
};
const known = (error: unknown): never => {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof MerchantComboPartError) throw error;
  if (/COMBO_PART_NOT_FOUND|COMBO_PART_INPUT_INVALID/u.test(message)) return fail("NotFound");
  if (/COMBO_PART_NOT_READY/u.test(message)) return fail("NotReady");
  // The database refuses a dish of a cancelled work item.
  if ((error as { code?: unknown } | null)?.code === "23514") return fail("Conflict");
  throw error;
};
type Tx = ConsumerTransaction;

export function createMerchantComboPartCommands(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  locale: string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const run = <T>(
    input: { sessionCookie: unknown; csrf: unknown },
    sessionReference: string,
    action: string,
    work: (
      tx: Tx,
      scope: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly storeReference: string;
        readonly actorReference: string;
      },
    ) => Promise<T>,
  ) =>
    retryTransactionConflict(() =>
      options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const resolved = await resolveScope(
                transaction,
                input.sessionCookie,
                action,
                sessionReference,
              );
              if ((await resolved.allowed()) !== true) return fail("PermissionDenied");
              return resolved;
            },
            recheck: async (resolved) => (await resolved.allowed()) === true,
            denied: () => fail("PermissionDenied"),
          },
          async (authority) => {
            const resolved = authority.scope;
            const tx = transaction as unknown as Tx;
            authority.bind(tx);
            return work(tx, {
              tenantReference: String(resolved.selected.tenantReference),
              brandReference: String(resolved.context.brand.brandReference),
              storeReference: String(resolved.store.storeReference),
              actorReference: String(resolved.actorReference),
            });
          },
        ),
      ),
    );

  /** The kitchen: one dish of a combo is done. */
  const kitchenDone = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    let body: Readonly<Record<string, unknown>>;
    try {
      body = readClosedRecord(input.body, [
        "operationReference",
        "workItemReference",
        "optionReference",
      ]);
    } catch {
      return fail("Invalid");
    }
    const command = {
      operationReference: reference(body.operationReference),
      workItemReference: reference(body.workItemReference),
      optionReference: reference(body.optionReference),
    };
    const session = await options.authentication.authorize(input);
    if (session?.policy?.code !== "NamedKdsOperator") return fail("PermissionDenied");
    return run(input, session.sessionReference, "kitchen.operate", async (tx, scope) => {
      try {
        const item = await loadKitchenWorkItemChoices(tx, scope, command.workItemReference);
        if (item === null) return fail("NotFound");
        if (item.status === "Cancelled") return fail("Conflict");
        return await markKitchenComboPartDone(tx, scope, {
          workItemReference: command.workItemReference,
          orderItemReference: item.orderItemReference,
          optionReferences: item.optionReferences,
          optionReference: command.optionReference,
          operationReference: command.operationReference,
          actorReference: scope.actorReference,
          at: options.persistence.now(),
          locale: options.locale,
        });
      } catch (error) {
        return known(error);
      }
    });
  };

  /** A server: one dish of a combo is served at its table. */
  const tableServed = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    let body: Readonly<Record<string, unknown>>;
    try {
      body = readClosedRecord(input.body, [
        "operationReference",
        "orderReference",
        "orderItemReference",
        "optionReference",
      ]);
    } catch {
      return fail("Invalid");
    }
    const command = {
      operationReference: reference(body.operationReference),
      orderReference: reference(body.orderReference),
      orderItemReference: reference(body.orderItemReference),
      optionReference: reference(body.optionReference),
    };
    const session = await options.authentication.authorize(input);
    return run(input, session.sessionReference, "dining.item.serve", async (tx, scope) => {
      try {
        const order = await createPostgresMerchantOrderIndex({
          ...scope,
          authorize: async () => true,
        }).find({ transaction: tx, orderReference: command.orderReference });
        if (order === null || order.orderType !== "DineIn" || order.diningSessionReference === null)
          return fail("NotFound");
        const lines = await loadMerchantOrderLines(
          tx,
          scope,
          command.orderReference,
          options.locale,
        );
        const line = lines?.items.find((l) => l.orderItemReference === command.orderItemReference);
        if (line === undefined) return fail("NotFound");
        return await markDiningComboPartServed(tx, scope, {
          diningSessionReference: String(order.diningSessionReference),
          orderItemReference: command.orderItemReference,
          optionReferences: line.options.map((o) => o.optionReference),
          optionReference: command.optionReference,
          operationReference: command.operationReference,
          actorReference: scope.actorReference,
          at: options.persistence.now(),
          locale: options.locale,
        });
      } catch (error) {
        return known(error);
      }
    });
  };
  return { kitchenDone, tableServed };
}
