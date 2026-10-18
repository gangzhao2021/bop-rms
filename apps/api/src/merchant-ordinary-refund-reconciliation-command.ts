import { parseDigitalReceiptRecord } from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, parseCanonicalInstant, readClosedRecord } from "@bop/identity";
import { createPostgresOrdinaryRefundReconciliationRuntime } from "@rms/payment";
import { createMerchantRefundTransactions } from "./merchant-refund-transactions.js";
import type { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
type Preparation = Parameters<typeof createMerchantOrdinaryRefundCommand>[0];
type Runtime = Parameters<typeof createPostgresOrdinaryRefundReconciliationRuntime>[0];
type Context = Awaited<ReturnType<typeof createMerchantRefundTransactions>>;
/** Exact observation replay recovers durable outcome. Receipt failure leaves the
 * observation committed; retry the same command to retry receipt issuance. */
export function createMerchantOrdinaryRefundReconciliationCommand(options: {
  persistence: Preparation["persistence"];
  authentication: Preparation["authentication"];
  resolveConfiguration(
    context: Pick<Context, "scope" | "actorReference" | "resolveAuthority" | "transactions">,
  ): Promise<{
    providerAccountReference: string;
    environment: Runtime["environment"];
    provider: Runtime["provider"];
    refreshReceiptSources(request: { orderReference: string }): Promise<{ freshAfter: string }>;
    issueRefundReceipt(
      tx: ConsumerTransaction,
      request: { orderReference: string; freshAfter: string },
    ): Promise<unknown>;
  }>;
}) {
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    const keys = [
      "orderReference",
      "operationReference",
      "observationReference",
      "auditReference",
    ] as const;
    const raw = readClosedRecord(input.command, [...keys]);
    const command = Object.fromEntries(
      keys.map((k) => [k, String(parseOpaqueUuidV7(raw[k], "ACTOR_REFERENCE_INVALID"))]),
    ) as Record<(typeof keys)[number], string>;
    const context = await createMerchantRefundTransactions({
      persistence: options.persistence,
      sessionCookie: input.sessionCookie,
      sessionReference: session.sessionReference,
      orderReference: command.orderReference,
    });
    const config = await options.resolveConfiguration({
      scope: context.scope,
      actorReference: context.actorReference,
      resolveAuthority: context.resolveAuthority,
      transactions: context.transactions,
    });
    const reconcile = createPostgresOrdinaryRefundReconciliationRuntime({
      scope: context.scope,
      providerAccountReference: config.providerAccountReference,
      environment: config.environment,
      provider: config.provider,
      transactions: context.transactions,
      authorize: context.authorize,
    });
    const result = await reconcile(command);
    const refreshed = readClosedRecord(
      await config.refreshReceiptSources({ orderReference: command.orderReference }),
      ["freshAfter"],
    );
    const freshAfter = String(parseCanonicalInstant(refreshed.freshAfter));
    const receipt = await context.transactions.run(async (tx) => {
      const issued = readClosedRecord(
        await config.issueRefundReceipt(tx, { orderReference: command.orderReference, freshAfter }),
        ["status", "record"],
      );
      const record = parseDigitalReceiptRecord(issued.record);
      if (
        (issued.status !== "Created" && issued.status !== "Existing") ||
        (issued.status === "Created" && record.kind !== "Refund") ||
        record.kind === "Void" ||
        record.snapshot.orderReference !== command.orderReference ||
        record.snapshot.brandReference !== context.scope.brandReference ||
        record.snapshot.storeReference !== context.scope.storeReference
      )
        throw new Error("REFUND_RECEIPT_RESULT_INVALID");
      return Object.freeze({ status: issued.status, version: record.version, kind: record.kind });
    });
    return Object.freeze({ result, receipt });
  };
}
