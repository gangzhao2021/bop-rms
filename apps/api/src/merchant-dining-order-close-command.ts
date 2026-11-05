import type { ConsumerTransaction } from "@bop/eventing";
import type { AppendAuditRecordInput } from "@bop/audit";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import {
  OrderCloseCommandError,
  refuseOrderClose as refuse,
  runDiningOrderClose,
  type OrderCloseCommandErrorCode,
} from "./dining-order-close-run.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  actorReference: string;
}
interface Command {
  orderReference: string;
  operationReference: string;
  expectedOrderVersion: number;
  expectedClosureVersion: number;
  reasonCode: string;
}
const fail = (): never => {
  throw new Error("ORDER_CLOSE_COMMAND_UNAVAILABLE");
};
export { OrderCloseCommandError, type OrderCloseCommandErrorCode };
const reference = (v: unknown) => String(parseOpaqueUuidV7(v, "ACTOR_REFERENCE_INVALID"));
/** Server-owned employee command; no client proof, Actor, Store, timestamp or Audit. */
export function createMerchantDiningOrderCloseCommand(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: Scope,
    command: Command,
    authority: { authorize(): Promise<boolean> },
  ): Promise<{
    providerAccountReference: string;
    environment: "Test" | "Live";
    diningSessionReference: string;
    guestSessionReference: string;
  }>;
  newReference(): string;
  audit: Pick<AppendAuditRecordInput, "retentionPolicyCode" | "retentionPolicyVersion">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    try {
      return await run(input);
    } catch (error) {
      if (error instanceof OrderCloseCommandError) throw error;
      return refuse("ORDER_CLOSE_UNAVAILABLE");
    }
  };
  async function run(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
    let authenticated: Awaited<ReturnType<MerchantBffService["authorize"]>>;
    try {
      authenticated = await options.authentication.authorize(input);
    } catch {
      return refuse("ORDER_CLOSE_PERMISSION_DENIED");
    }
    let command: Command;
    try {
      command = parseCommand(input.command);
    } catch {
      return refuse("ORDER_CLOSE_INPUT_INVALID");
    }
    return runCommand(input, authenticated, command);
  }
  function parseCommand(value: unknown): Command {
    const raw = readClosedRecord(value, [
      "orderReference",
      "operationReference",
      "expectedOrderVersion",
      "expectedClosureVersion",
      "reasonCode",
    ]);
    const version = (v: unknown, min: number) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v >= 2147483647)
        return fail();
      return v;
    };
    if (typeof raw.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode))
      return fail();
    const command = Object.freeze({
      orderReference: reference(raw.orderReference),
      operationReference: reference(raw.operationReference),
      expectedOrderVersion: version(raw.expectedOrderVersion, 1),
      expectedClosureVersion: version(raw.expectedClosureVersion, 0),
      reasonCode: raw.reasonCode,
    });
    return command;
  }
  function runCommand(
    input: { sessionCookie: unknown },
    authenticated: Awaited<ReturnType<MerchantBffService["authorize"]>>,
    command: Command,
  ) {
    // WP-2423: one authorized run. The caller (Session, selection, membership, store assignment and
    // the `order.close` permission) is resolved in full once at the start and once more before the
    // reply; every owner read in between is fenced by the run's guard, which costs no query.
    // Re-resolving the caller inside every owner read (as before) cost thousands of statements and
    // held the Order's payment and closure rows for 7-8 s on a one-round table.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            let current: Awaited<ReturnType<typeof resolveScope>>;
            try {
              current = await resolveScope(
                transaction,
                input.sessionCookie,
                "order.close",
                authenticated.sessionReference,
              );
            } catch {
              return refuse("ORDER_CLOSE_PERMISSION_DENIED");
            }
            if ((await current.allowed()) !== true) return refuse("ORDER_CLOSE_PERMISSION_DENIED");
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied: () => refuse("ORDER_CLOSE_PERMISSION_DENIED"),
        },
        (authority) => closeInRun(transaction, authority, command),
      ),
    );
  }
  async function closeInRun(
    transaction: Parameters<Parameters<PersistentMerchantBffOptions["transactions"]["run"]>[0]>[0],
    authority: MerchantTransactionAuthority<Awaited<ReturnType<typeof resolveScope>>>,
    command: Command,
  ) {
    const current = authority.scope;
    const scope = {
        tenantReference: current.selected.tenantReference,
        brandReference: String(current.context.brand.brandReference),
        storeReference: String(current.store.storeReference),
      },
      actorReference = String(current.actorReference);
    const tx: ConsumerTransaction = {
      async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
        const result = await transaction.query(sql, values);
        if (!result || typeof result !== "object") return fail();
        const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown,
          rowCount = Object.getOwnPropertyDescriptor(result, "rowCount")?.value as unknown;
        if (
          !Array.isArray(rows) ||
          (rowCount !== null &&
            (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0))
        )
          return fail();
        return { rows: rows as readonly Row[], rowCount: rowCount as number | null };
      },
    };
    // Owner reads: fenced by this run (no query); the caller is re-resolved in full before the reply.
    const authorize = () => authority.guard();
    return runDiningOrderClose({
      tx,
      scope,
      actor: { type: "User", reference: actorReference },
      sourceChannel: "MERCHANT_WEB",
      command,
      now: options.persistence.now(),
      authorize,
      newReference: options.newReference,
      audit: options.audit,
      resolveConfiguration: () =>
        options.resolveConfiguration(tx, { ...scope, actorReference }, command, { authorize }),
    });
  }
}
