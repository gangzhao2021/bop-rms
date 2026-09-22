import { createHash } from "node:crypto";
import { createPostgresTaskSourceReader, createTaskScope } from "@bop/task";
import { createDiningOrderExecutionPosition } from "./dining-order-execution-position.js";
import { createPostgresOrderPaymentAttemptPosition } from "@rms/payment";
const fail = (): never => {
  throw new Error("DINING_ORDER_TASK_POSITION_UNAVAILABLE");
};
type Options = Parameters<typeof createDiningOrderExecutionPosition>[0] & {
  paymentScope: Parameters<typeof createPostgresOrderPaymentAttemptPosition>[0]["scope"];
};
type Input = Parameters<ReturnType<typeof createDiningOrderExecutionPosition>["load"]>[0];
/** Complete tasks for the verified Order and shared DiningSession, including terminal
 * tasks. Neither lifecycle status nor an empty inbox constitutes financial clearance.
 * Caller retains Order→Kitchen→Dining→Payment→Task fences until its transaction ends. */
export function createDiningOrderTaskPosition(options: Options) {
  const execution = createDiningOrderExecutionPosition(options);
  return Object.freeze({
    async load(input: Input) {
      try {
        if ((await options.authorize(input.transaction, input)) !== true) return fail();
        const current = await execution.load(input);
        if (!current) return null;
        const payment = await createPostgresOrderPaymentAttemptPosition({
          scope: options.paymentScope,
          authorize: () => options.authorize(input.transaction, input),
        }).load(input.transaction, {
          orderReference: current.orderReference,
          observedAt: current.observedAt,
        });
        if (
          payment.brandReference !== String(current.brandReference) ||
          payment.storeReference !== String(current.storeReference) ||
          payment.orderReference !== String(current.orderReference) ||
          payment.observedAt !== current.observedAt ||
          payment.providerAccountReference !== options.paymentScope.providerAccountReference ||
          payment.environment !== options.paymentScope.environment ||
          !/^sha256:[a-f0-9]{64}$/u.test(payment.snapshotDigest)
        )
          return fail();
        const attempts = payment.attempts.map((a) => a.paymentAttemptReference).sort();
        if (new Set(attempts).size !== attempts.length) return fail();
        const reader = createPostgresTaskSourceReader({
          scope: createTaskScope({
            kind: "Store",
            brandReference: current.brandReference,
            storeReference: current.storeReference,
          }),
          authorizeAndFence: () => options.authorize(input.transaction, input),
        });
        const queries = [
          {
            sourceType: "DINING_SESSION",
            sourceReference: input.diningSessionReference,
            observedAt: current.observedAt,
          },
          {
            sourceType: "ORDER",
            sourceReference: current.orderReference,
            observedAt: current.observedAt,
          },
        ];
        queries.push(
          ...attempts.map((reference) => ({
            sourceType: "PAYMENT_ATTEMPT",
            sourceReference: reference,
            observedAt: current.observedAt,
          })),
        );
        const snapshots = [];
        for (const query of queries) {
          const result = await reader.load(input.transaction, query);
          if (
            result.scope.kind !== "Store" ||
            String(result.scope.brandReference) !== String(current.brandReference) ||
            String(result.scope.storeReference) !== String(current.storeReference) ||
            result.sourceType !== query.sourceType ||
            result.sourceReference !== query.sourceReference ||
            result.observedAt !== query.observedAt ||
            !/^sha256:[a-f0-9]{64}$/u.test(result.snapshotDigest)
          )
            return fail();
          snapshots.push(result);
        }
        if ((await options.authorize(input.transaction, input)) !== true) return fail();
        return Object.freeze({
          execution: current,
          paymentAttempts: payment,
          taskSources: Object.freeze(snapshots),
          snapshotDigest:
            "sha256:" +
            createHash("sha256")
              .update(
                JSON.stringify([
                  current.snapshotDigest,
                  payment.snapshotDigest,
                  ...snapshots.map((s) => s.snapshotDigest),
                ]),
              )
              .digest("hex"),
        });
      } catch {
        return fail();
      }
    },
  });
}
