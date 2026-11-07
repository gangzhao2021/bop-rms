import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentInstant } from "./payment-intent-creation.js";
import {
  parseReconciliationFollowUp,
  parseReconciliationFollowUpCommand,
  transitionReconciliationFollowUp,
  ReconciliationFollowUpError,
} from "./reconciliation-follow-up.js";
type Command = ReturnType<typeof parseReconciliationFollowUpCommand>;
type State = ReturnType<typeof parseReconciliationFollowUp>;
export interface ReconciliationFollowUpTransition {
  readonly command: Command;
  readonly before: State;
  readonly after: State;
}
export interface ReconciliationFollowUpPorts {
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly now: () => string;
  /** Must validate current named employee authority, scope, purpose and, for Assign,
   * current eligible assignee membership. System identity is not sufficient. */
  readonly authorize: (
    tx: ConsumerTransaction,
    command: Command,
    purpose: "OperatePaymentReconciliation",
  ) => Promise<boolean>;
  readonly records: {
    /** Hold scoped operation and exception fences until transaction completion. */
    lock(tx: ConsumerTransaction, command: Command): Promise<void>;
    findOperation(
      tx: ConsumerTransaction,
      command: Command,
    ): Promise<ReconciliationFollowUpTransition | null>;
    /** Read committed owner history or validated original Open exception, never client state. */
    readCurrent(tx: ConsumerTransaction, command: Command): Promise<unknown>;
    append(tx: ConsumerTransaction, transition: ReconciliationFollowUpTransition): Promise<void>;
  };
  readonly audit: {
    append(tx: ConsumerTransaction, transition: ReconciliationFollowUpTransition): Promise<void>;
  };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const conflict = (): never => {
  throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_CONFLICT");
};
export function createReconciliationFollowUpService(ports: ReconciliationFollowUpPorts) {
  return Object.freeze({
    execute: async (value: unknown) => {
      const command = parseReconciliationFollowUpCommand(value);
      try {
        if (command.occurredAt > parsePaymentInstant(ports.now())) return conflict();
        return await ports.transactions.run(async (tx) => {
          const authorize = async () => {
            if ((await ports.authorize(tx, command, "OperatePaymentReconciliation")) !== true)
              throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED");
          };
          await authorize();
          await ports.records.lock(tx, command);
          await authorize();
          const previous = await ports.records.findOperation(tx, command);
          if (previous !== null) {
            const recorded = parseReconciliationFollowUpCommand(previous.command);
            if (!same(command, recorded)) return conflict();
            const before = parseReconciliationFollowUp(previous.before),
              after = parseReconciliationFollowUp(previous.after);
            if (!same(after, transitionReconciliationFollowUp(before, recorded))) return conflict();
            await authorize();
            return Object.freeze({ status: "Duplicate" as const, state: after });
          }
          const before = parseReconciliationFollowUp(await ports.records.readCurrent(tx, command));
          const after = transitionReconciliationFollowUp(before, command);
          const transition = Object.freeze({ command, before, after });
          await authorize();
          await ports.records.append(tx, transition);
          await ports.audit.append(tx, transition);
          await authorize();
          return Object.freeze({ status: "Created" as const, state: after });
        });
      } catch (error) {
        if (error instanceof ReconciliationFollowUpError) throw error;
        throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_UNAVAILABLE");
      }
    },
  });
}
