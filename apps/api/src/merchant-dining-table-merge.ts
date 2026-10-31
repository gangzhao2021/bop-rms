import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  DiningMergeError,
  createPostgresDiningSessionReadStore,
  createPostgresDiningTableStore,
  loadDiningPartySizes,
  mergeDiningSessions,
  parseDiningInstant,
  parseDiningReference,
  recordDiningPartySize,
  resolveDiningMergeOperation,
} from "@rms/dining";
import { diningSessionHasUnsentCart, recordOrderMerge } from "@rms/ordering";
import { DiningTableSettlementStoreError, recordDiningTableBillOrder } from "@rms/payment";
import { markDiningTableNeedsCleaning } from "./dining-table-needs-cleaning.js";
import { readDiningTableBill } from "./merchant-dining-table-checkout.js";
import { derivedReference } from "./merchant-products.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantDiningTableMergeErrorCode =
  | "DINING_TABLE_MERGE_INPUT_INVALID"
  | "DINING_TABLE_MERGE_PERMISSION_DENIED"
  /** A table changed meanwhile (seated, moved, merged, checking out): read the tables again. */
  | "DINING_TABLE_MERGE_CHANGED"
  /** This table or the other has no party seated. */
  | "DINING_TABLE_MERGE_NOT_SEATED"
  /** A table pays for each round (merging is for tables that pay at the end). */
  | "DINING_TABLE_MERGE_PAYS_EACH_ROUND"
  /** A table is checking out or closed. */
  | "DINING_TABLE_MERGE_CHECKING_OUT"
  /** Something on a table's bill was paid, split or written off. */
  | "DINING_TABLE_MERGE_PAYMENT_STARTED"
  /** The other table has not ordered while this one has (merge it into this table instead). */
  | "DINING_TABLE_MERGE_TARGET_NOT_ORDERED"
  /** This table's guests have dishes in their cart not sent yet. */
  | "DINING_TABLE_MERGE_UNSENT_CART"
  /** Together the parties would be more than 99 guests. */
  | "DINING_TABLE_MERGE_TOO_MANY_GUESTS"
  | "DINING_TABLE_MERGE_UNAVAILABLE";
export class MerchantDiningTableMergeError extends Error {
  constructor(readonly code: MerchantDiningTableMergeErrorCode) {
    super("dining table merge " + code);
    this.name = "MerchantDiningTableMergeError";
  }
}
const fail = (code: MerchantDiningTableMergeErrorCode): never => {
  throw new MerchantDiningTableMergeError(code);
};
const intent = (value: unknown) =>
  "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface MerchantDiningTableMergeResult {
  readonly status: "Applied" | "AlreadyApplied";
  /** The party the guests are at now (the other table's). */
  readonly diningSessionReference: string;
  readonly tableReference: string;
  readonly tableLabel: string;
  readonly fromTableReference: string;
  readonly fromTableLabel: string;
  readonly partySize: number;
}

/**
 * WP-2423 item 8 ⑨ (Owner decision 3, DEC-DINING-TABLE-MERGE): staff merge the party at this
 * table into the party seated at another. Only tables that pay at the end, still ordering, with
 * nothing paid, split or written off; the other table must have ordered when this one has. In one
 * transaction: Dining records the merge (this table's session ends, the table waits for cleaning,
 * the other session moves on), the other table's party size becomes both together, Ordering puts
 * this table's Order on the other's bill and Payment records the bill's Orders. Its codes and
 * invitations stop admitting anyone (the session is closed); its phones are told where the party
 * sits and scan that table's code. The same operation again returns the same result; two staff at
 * once: one merges, the other is told the tables changed.
 */
export function createMerchantDiningTableMerge(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<MerchantDiningTableMergeResult> => {
    const authenticated = await options.authentication.authorize(input);
    let command: {
      operationReference: string;
      tableReference: string;
      expectedTableVersion: number;
      targetTableReference: string;
      expectedTargetTableVersion: number;
    };
    try {
      const raw = readClosedRecord(input.command, [
        "action",
        "operationReference",
        "tableReference",
        "expectedTableVersion",
        "targetTableReference",
        "expectedTargetTableVersion",
      ]);
      if (
        raw.action !== "Merge" ||
        !Number.isSafeInteger(raw.expectedTableVersion) ||
        Number(raw.expectedTableVersion) < 1 ||
        !Number.isSafeInteger(raw.expectedTargetTableVersion) ||
        Number(raw.expectedTargetTableVersion) < 1
      )
        return fail("DINING_TABLE_MERGE_INPUT_INVALID");
      command = {
        operationReference: String(parseDiningReference(raw.operationReference)),
        tableReference: String(parseDiningReference(raw.tableReference)),
        expectedTableVersion: Number(raw.expectedTableVersion),
        targetTableReference: String(parseDiningReference(raw.targetTableReference)),
        expectedTargetTableVersion: Number(raw.expectedTargetTableVersion),
      };
      if (command.tableReference === command.targetTableReference)
        return fail("DINING_TABLE_MERGE_INPUT_INVALID");
    } catch (error) {
      if (error instanceof MerchantDiningTableMergeError) throw error;
      return fail("DINING_TABLE_MERGE_INPUT_INVALID");
    }
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                "dining.operate",
                authenticated.sessionReference,
              ).catch(() => fail("DINING_TABLE_MERGE_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("DINING_TABLE_MERGE_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("DINING_TABLE_MERGE_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope,
              guard = () => authority.guard();
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const owner = {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            };
            const consumer = tx as unknown as ConsumerTransaction;
            const runner = { run: <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx) };
            const hashes = {
              hashIntent: (value: string) =>
                "sha256:" + createHash("sha256").update(value).digest("hex"),
              equals: (a: string, b: string) => a === b,
            };
            const tables = createPostgresDiningTableStore(runner as never, scope, hashes);
            const sessions = createPostgresDiningSessionReadStore(runner as never, scope);
            const actor = String(current.actorReference);
            // The table it left waits for cleaning (once per merge, also on a retry).
            const clean = (observedAt: string) =>
              markDiningTableNeedsCleaning(tx, {
                scope,
                actorReference: actor,
                tableReference: command.tableReference,
                operationReference: derivedReference(command.operationReference, "clean"),
                correlationReference: command.operationReference,
                observedAt,
                retentionPolicyCode: options.retentionPolicyCode,
                retentionPolicyVersion: options.retentionPolicyVersion,
                newReference: options.newReference,
                authorize: guard,
              });
            const result = (
              record: {
                readonly targetSessionReference: string;
                readonly targetTableReference: string;
                readonly targetTableLabel: string;
                readonly sourceTableReference: string;
                readonly sourceTableLabel: string;
                readonly mergedPartySize: number;
              },
              status: "Applied" | "AlreadyApplied",
            ): MerchantDiningTableMergeResult =>
              Object.freeze({
                status,
                diningSessionReference: record.targetSessionReference,
                tableReference: record.targetTableReference,
                tableLabel: record.targetTableLabel,
                fromTableReference: record.sourceTableReference,
                fromTableLabel: record.sourceTableLabel,
                partySize: record.mergedPartySize,
              });
            const prior = await resolveDiningMergeOperation(
              tx as never,
              scope,
              command.operationReference,
            );
            if (prior !== null) {
              if (
                prior.sourceTableReference !== command.tableReference ||
                prior.targetTableReference !== command.targetTableReference ||
                prior.expectedSourceTableVersion !== command.expectedTableVersion ||
                prior.expectedTargetTableVersion !== command.expectedTargetTableVersion
              )
                return fail("DINING_TABLE_MERGE_INPUT_INVALID");
              await clean(prior.occurredAt);
              return result(prior, "AlreadyApplied");
            }
            const source = await tables.loadTable(parseDiningReference(command.tableReference));
            const target = await tables.loadTable(
              parseDiningReference(command.targetTableReference),
            );
            if (source === null || target === null) return fail("DINING_TABLE_MERGE_INPUT_INVALID");
            if (
              source.aggregateVersion !== command.expectedTableVersion ||
              target.aggregateVersion !== command.expectedTargetTableVersion
            )
              return fail("DINING_TABLE_MERGE_CHANGED");
            const sourceSession = source.activeDiningSessionReference,
              targetSession = target.activeDiningSessionReference;
            if (sourceSession === null || targetSession === null)
              return fail("DINING_TABLE_MERGE_NOT_SEATED");
            const [sourceParty, targetParty] = await sessions.loadSessions([
              String(sourceSession),
              String(targetSession),
            ]);
            if (
              sourceParty === undefined ||
              sourceParty === null ||
              targetParty === undefined ||
              targetParty === null
            )
              return fail("DINING_TABLE_MERGE_CHANGED");
            if (sourceParty.phase !== "Active" || targetParty.phase !== "Active")
              return fail("DINING_TABLE_MERGE_CHECKING_OUT");
            const observedAt = String(parseDiningInstant(current.context.resolvedAt));
            const bill = (session: string) =>
              readDiningTableBill(consumer, scope, {
                diningSessionReference: session,
                observedAt,
                authorize: guard,
              });
            const sourceBill = await bill(String(sourceSession)),
              targetBill = await bill(String(targetSession));
            if (sourceBill.paymentTiming !== "PayLater" || targetBill.paymentTiming !== "PayLater")
              return fail("DINING_TABLE_MERGE_PAYS_EACH_ROUND");
            for (const entry of [sourceBill, targetBill]) {
              if (!entry.consistent) return fail("DINING_TABLE_MERGE_CHANGED");
              if (
                entry.settlement !== null ||
                entry.writeOff !== null ||
                entry.onlinePayment !== null ||
                entry.split !== null ||
                entry.rounds.some((round) => round.paid)
              )
                return fail("DINING_TABLE_MERGE_PAYMENT_STARTED");
            }
            if (sourceBill.orderReference !== null && targetBill.orderReference === null)
              return fail("DINING_TABLE_MERGE_TARGET_NOT_ORDERED");
            if (await diningSessionHasUnsentCart(consumer, owner, String(sourceSession)))
              return fail("DINING_TABLE_MERGE_UNSENT_CART");
            const parties = await loadDiningPartySizes(tx as never, scope, [
              String(sourceSession),
              String(targetSession),
            ]);
            const sourceGuests = parties.get(String(sourceSession))?.partySize ?? 1,
              targetSize = parties.get(String(targetSession));
            const targetGuests = targetSize?.partySize ?? 1;
            if (sourceGuests + targetGuests > 99) return fail("DINING_TABLE_MERGE_TOO_MANY_GUESTS");
            const mergeCommand = {
              operationReference: command.operationReference,
              sourceTableReference: command.tableReference,
              targetTableReference: command.targetTableReference,
              sourceSessionReference: String(sourceSession),
              targetSessionReference: String(targetSession),
              expectedSourceTableVersion: command.expectedTableVersion,
              expectedTargetTableVersion: command.expectedTargetTableVersion,
              expectedSourceSessionVersion: sourceParty.version,
              expectedTargetSessionVersion: targetParty.version,
              sourcePartySize: sourceGuests,
              targetPartySize: targetGuests,
              actorReference: actor,
              observedAt,
            };
            if (!(await guard())) return fail("DINING_TABLE_MERGE_PERMISSION_DENIED");
            const merged = await mergeDiningSessions(
              tx as never,
              scope,
              { ...mergeCommand, intentDigest: intent(command) },
              {
                auditId: options.newReference(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "User", reference: actor },
                reasonCode: "TABLES_MERGED",
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Restricted",
                retentionPolicyCode: options.retentionPolicyCode,
                retentionPolicyVersion: options.retentionPolicyVersion,
              },
            );
            // The bill: this table's Order joins the other's (Ordering), and Payment records the
            // bill's Orders for its own rules.
            if (sourceBill.orderReference !== null && targetBill.orderReference !== null) {
              await recordOrderMerge(consumer, owner, {
                mergeReference: derivedReference(command.operationReference, "order-merge"),
                operationReference: command.operationReference,
                sourceOrderReference: sourceBill.orderReference,
                targetOrderReference: targetBill.orderReference,
                sourceDiningSessionReference: String(sourceSession),
                targetDiningSessionReference: String(targetSession),
                actorReference: actor,
                mergedAt: observedAt,
              });
              await recordDiningTableBillOrder(tx as never, owner, {
                operationReference: command.operationReference,
                billOrderReference: targetBill.orderReference,
                memberOrderReference: sourceBill.orderReference,
                recordedAt: observedAt,
              });
            }
            // Both parties at the other table now (the tea follows, as for any party size).
            await recordDiningPartySize(tx as never, scope, {
              diningSessionReference: String(targetSession),
              operationReference: derivedReference(command.operationReference, "party-size"),
              expectedVersion: targetSize?.version ?? 0,
              partySize: sourceGuests + targetGuests,
              actorReference: actor,
              observedAt,
            });
            await clean(observedAt);
            return result(merged.record, merged.status);
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantDiningTableMergeError) throw error;
      if (
        error instanceof DiningMergeError &&
        (error.code === "DINING_MERGE_CHANGED" ||
          error.code === "DINING_MERGE_IDEMPOTENCY_CONFLICT")
      )
        return fail("DINING_TABLE_MERGE_CHANGED");
      if (
        error instanceof DiningTableSettlementStoreError &&
        error.code === "DINING_TABLE_SETTLEMENT_ALREADY_PAID"
      )
        return fail("DINING_TABLE_MERGE_PAYMENT_STARTED");
      // Another staff member changed the tables at the same moment (a serialization or lock
      // conflict): read them again.
      if ((error as { code?: unknown } | null)?.code === "40001")
        return fail("DINING_TABLE_MERGE_CHANGED");
      throw error;
    }
  };
}
