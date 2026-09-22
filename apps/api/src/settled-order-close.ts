import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderSettledFinalityStore, type OrderSettledFinality } from "@rms/payment";
import {
  createPostgresOrderClosureStore,
  parseOrderClosureRecord,
  type OrderClosureRecord,
} from "@rms/ordering";
type PaymentOptions = Parameters<typeof createPostgresOrderSettledFinalityStore>[0];
type ClosureOptions = Parameters<typeof createPostgresOrderClosureStore>[0];
const fail = (): never => {
  throw new Error("SETTLED_ORDER_CLOSE_UNAVAILABLE");
};
/** Server-only orchestration. Caller retains transaction and all owner fences.
 * Evidence must resolve complete current execution/pending-request/Task clearance;
 * this adapter never substitutes settlement for those independent requirements. */
export function createSettledOrderClose(options: {
  payment: PaymentOptions;
  closure: Omit<ClosureOptions, "closeEvidence" | "reopenEvidence">;
  closeEvidence(
    tx: ConsumerTransaction,
    record: OrderClosureRecord,
    financial: OrderSettledFinality,
  ): Promise<unknown>;
}) {
  const payment = createPostgresOrderSettledFinalityStore(options.payment);
  async function run(
    tx: ConsumerTransaction,
    financialInput: unknown,
    prepare: (fact: OrderSettledFinality) => Promise<unknown>,
    authorizeIntent: () => Promise<boolean>,
  ) {
    let saved = false;
    try {
      if ((await authorizeIntent()) !== true) return fail();
      await tx.query("SAVEPOINT settled_order_close", []);
      saved = true;
      const financial = await payment.commit(tx, financialInput),
        fact = financial.record;
      const record = parseOrderClosureRecord(await prepare(fact));
      if (
        record.status !== "Closed" ||
        (await options.closure.authorize(tx, record)) !== true ||
        fact.tenantReference !== String(record.tenantReference) ||
        fact.brandReference !== String(record.brandReference) ||
        fact.storeReference !== String(record.storeReference) ||
        fact.orderReference !== String(record.orderReference) ||
        fact.orderVersion !== record.orderVersion ||
        fact.decidedAt !== String(record.occurredAt) ||
        fact.finalityReference !== String(record.financialFinalityReference)
      )
        return fail();
      const closure = await createPostgresOrderClosureStore({
        ...options.closure,
        reopenEvidence: async () => fail(),
        closeEvidence: (inner, current) => options.closeEvidence(inner, current, fact),
      }).commit(tx, record);
      if (closure.status !== financial.status) return fail();
      await tx.query("RELEASE SAVEPOINT settled_order_close", []);
      saved = false;
      return Object.freeze({ status: closure.status, closure: closure.record, financial: fact });
    } catch {
      if (saved) {
        await tx.query("ROLLBACK TO SAVEPOINT settled_order_close", []);
        await tx.query("RELEASE SAVEPOINT settled_order_close", []);
      }
      return fail();
    }
  }
  return Object.freeze({
    async commit(tx: ConsumerTransaction, input: { closure: unknown; financial: unknown }) {
      let record: OrderClosureRecord;
      try {
        record = parseOrderClosureRecord(input.closure);
      } catch {
        return fail();
      }
      return run(
        tx,
        input.financial,
        async () => record,
        async () =>
          record.status === "Closed" && (await options.closure.authorize(tx, record)) === true,
      );
    },
    /** Server preparation runs after fresh Payment calculation, under the same
     * savepoint. Never accept a client callback or manufacture an owner record. */
    async commitPrepared(
      tx: ConsumerTransaction,
      input: {
        financial: unknown;
        authorizeIntent(): Promise<boolean>;
        prepareClosure(fact: OrderSettledFinality): Promise<unknown>;
      },
    ) {
      return run(tx, input.financial, input.prepareClosure, input.authorizeIntent);
    },
  });
}
