import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrdinaryRefundWorkSource,
  createPostgresOrdinaryRefundClaimOutcomeReader,
} from "./persistence/ordinary-refund-operation-store.js";
import { createPostgresOrdinaryRefundRecoverySource } from "./ordinary-refund-recovery-source.js";
import { parsePaymentInstant } from "../application/payment-intent-creation.js";

type Scope = Parameters<typeof createPostgresOrdinaryRefundWorkSource>[0]["scope"];
/** Confirmed ordinary refunds only; compensation and unresolved sends stay explicit. */
export function createPostgresOrdinaryRefundWindowSource(options: {
  scope: Scope;
  authorize(
    tx: ConsumerTransaction,
    input: { startsAt: string; endsAt: string; observedAt: string; purpose: "ReconcilePayments" },
  ): Promise<boolean>;
}) {
  const fail = (): never => {
    throw Error("ORDINARY_REFUND_WINDOW_UNAVAILABLE");
  };
  return async (
    tx: ConsumerTransaction,
    value: { startsAt: string; endsAt: string; observedAt: string },
  ) => {
    const input = {
      startsAt: parsePaymentInstant(value.startsAt),
      endsAt: parsePaymentInstant(value.endsAt),
      observedAt: parsePaymentInstant(value.observedAt),
      purpose: "ReconcilePayments" as const,
    };
    if (input.startsAt >= input.endsAt || input.endsAt > input.observedAt) return fail();
    const authorize = async (transaction: ConsumerTransaction) => {
      if ((await options.authorize(transaction, input)) !== true) return fail();
      return true;
    };
    await authorize(tx);
    const scan = createPostgresOrdinaryRefundWorkSource({ scope: options.scope, authorize });
    const recover = createPostgresOrdinaryRefundRecoverySource({
      scope: options.scope,
      providerAccountReference: options.scope.providerAccountReference,
      environment: options.scope.environment,
      authorize,
    });
    const readOutcome = createPostgresOrdinaryRefundClaimOutcomeReader({
      scope: options.scope,
      authorize,
      recover,
    });
    const operations = new Set<string>(),
      refunds = new Set<string>(),
      evidence = [];
    let afterOperationReference: string | null = null;
    let refundedAmountMinor = 0n,
      refundCount = 0,
      unresolvedOperationCount = 0;
    do {
      const page = await scan(tx, { afterOperationReference, limit: 100 });
      for (const candidate of page.candidates) {
        if (operations.has(candidate.operationReference) || operations.size >= 100000)
          return fail();
        operations.add(candidate.operationReference);
        if (candidate.workKind === "Dispatch") {
          unresolvedOperationCount++;
          evidence.push([candidate.operationReference, "NotDispatched"]);
          continue;
        }
        const recovered = await recover(tx, {
          orderReference: candidate.orderReference,
          operationReference: candidate.operationReference,
        });
        if (
          !recovered ||
          recovered.operation.requestReference !== candidate.requestReference ||
          recovered.operation.preparedAt > input.observedAt
        )
          return fail();
        const result = await readOutcome(tx, {
          orderReference: candidate.orderReference,
          requestReference: candidate.requestReference,
          paymentAttemptReference: recovered.operation.paymentAttemptReference,
          observedAt: input.observedAt,
        });
        if (!result || result.operation.operationReference !== candidate.operationReference)
          return fail();
        const { position } = result;
        evidence.push([
          candidate.operationReference,
          position.historyDigest,
          position.providerCreatedAt,
          position.confirmedMinor.toString(),
        ]);
        if (position.state !== "Confirmed") {
          unresolvedOperationCount++;
          continue;
        }
        if (
          position.providerCreatedAt === null ||
          position.providerRefundReference === null ||
          position.confirmedAt === null ||
          position.providerCreatedAt > position.confirmedAt ||
          position.confirmedMinor !== recovered.operation.amountMinor ||
          refunds.has(position.providerRefundReference)
        )
          return fail();
        refunds.add(position.providerRefundReference);
        if (
          position.providerCreatedAt >= input.startsAt &&
          position.providerCreatedAt < input.endsAt
        ) {
          refundCount++;
          refundedAmountMinor += position.confirmedMinor;
        }
      }
      if (
        page.nextAfterOperationReference !== null &&
        (page.candidates.length === 0 ||
          page.nextAfterOperationReference !== page.candidates.at(-1)?.operationReference ||
          (afterOperationReference !== null &&
            page.nextAfterOperationReference <= afterOperationReference))
      )
        return fail();
      afterOperationReference = page.nextAfterOperationReference;
    } while (afterOperationReference !== null);
    await authorize(tx);
    return Object.freeze({
      ...input,
      currencyCode: "CAD" as const,
      refundedAmountMinor,
      refundCount,
      unresolvedOperationCount,
      scannedOperationCount: operations.size,
      evidenceDigest:
        "sha256:" +
        createHash("sha256")
          .update(JSON.stringify(["ORDINARY_REFUND_WINDOW_V1", options.scope, input, evidence]))
          .digest("hex"),
    });
  };
}
