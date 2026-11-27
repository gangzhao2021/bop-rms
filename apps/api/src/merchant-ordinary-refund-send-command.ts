import type { ConsumerTransaction } from "@bop/eventing";
import type { TenantContext } from "@bop/tenant";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import { createMerchantRefundTransactions } from "./merchant-refund-transactions.js";
import { createMerchantOrdinaryRefundSend } from "./merchant-ordinary-refund-operation.js";
import type { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
type Preparation = Parameters<typeof createMerchantOrdinaryRefundCommand>[0];
type Send = Parameters<typeof createMerchantOrdinaryRefundSend>[0];
/** Internal authenticated command. Configuration resolves owner ports only;
 * it must not perform Provider I/O. Each owner transaction gets fresh session
 * authority; the Payment coordinator owns commit-before-send and recovery. */
export function createMerchantOrdinaryRefundSendCommand(options: {
  persistence: Preparation["persistence"];
  authentication: Preparation["authentication"];
  audit: Preparation["audit"];
  resolveConfiguration(input: {
    scope: Send["scope"];
    actorReference: string;
    resolveAuthority(tx: ConsumerTransaction): Promise<{
      context: TenantContext;
      authorize(): Promise<boolean>;
    }>;
  }): Promise<Omit<Send, "scope" | "transactions" | "authorize" | "authorizeRecovery">>;
}) {
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    const keys = [
      "operationReference",
      "orderReference",
      "requestReference",
      "dispatchReference",
      "auditReference",
    ] as const;
    const raw = readClosedRecord(input.command, [...keys, "approvalReference"]);
    const command = Object.fromEntries(
      keys.map((key) => [key, String(parseOpaqueUuidV7(raw[key], "ACTOR_REFERENCE_INVALID"))]),
    ) as Record<(typeof keys)[number], string>;
    const approvalReference =
      raw.approvalReference === null
        ? null
        : String(parseOpaqueUuidV7(raw.approvalReference, "ACTOR_REFERENCE_INVALID"));
    const { scope, actorReference, resolveAuthority, authorize, transactions } =
      await createMerchantRefundTransactions({
        persistence: options.persistence,
        sessionCookie: input.sessionCookie,
        sessionReference: session.sessionReference,
        orderReference: command.orderReference,
        requestReference: command.requestReference,
      });
    const configuration = await options.resolveConfiguration({
      scope,
      actorReference,
      resolveAuthority,
    });
    const send = createMerchantOrdinaryRefundSend({
      ...configuration,
      scope,
      authorize,
      authorizeRecovery: authorize,
      transactions,
    });
    return send({ ...command, approvalReference }, options.audit);
  };
}
