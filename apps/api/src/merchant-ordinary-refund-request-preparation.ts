import { approvalDerivedReference } from "./merchant-ordinary-refund-approval.js";

interface Input {
  sessionCookie: unknown;
  csrf: unknown;
  command: unknown;
}
interface Recorded {
  readonly status: string;
  readonly requestReference: string;
  readonly approvalRequired: boolean | null;
  readonly paymentAttemptReferences: readonly string[];
}
/** The request's prepared refund leg (sent by the browser next, or by the system's sender). */
export interface PreparedRefundLeg {
  readonly paymentAttemptReference: string;
  readonly operationReference: string;
}
/**
 * WP-2423 M16 (DEC-OWNER-DEFAULTS-2026-11-06 item 3): a refund that needs no approval is prepared
 * by the server in the same call that records it, on the requester's own session, so a page closed
 * right after "Refund" no longer leaves it recorded and never sent: the business worker sends what
 * is prepared. Each leg's references are derived from the request, so the browser's own prepare
 * (and any retry) replays the same operation. A leg the requester may not prepare (no
 * `payment.refund.execute`, or a card-machine payment refunded on the machine) is left to the
 * existing path; the request itself is never undone.
 */
export function withServerRefundPreparation<R extends Recorded>(
  request: (input: Input) => Promise<R>,
  prepare: (input: Input) => Promise<unknown>,
) {
  return async (input: Input): Promise<R & { readonly prepared: readonly PreparedRefundLeg[] }> => {
    const result = await request(input);
    const prepared: PreparedRefundLeg[] = [];
    if (result.approvalRequired === false) {
      // The request command validated it; the prepare command checks it again.
      const orderReference = (input.command as { orderReference?: unknown }).orderReference;
      for (const paymentAttemptReference of result.paymentAttemptReferences) {
        const operationReference = refundLegReference(
          result.requestReference,
          "operation:" + paymentAttemptReference,
        );
        try {
          await prepare({
            sessionCookie: input.sessionCookie,
            csrf: input.csrf,
            command: {
              orderReference,
              requestReference: result.requestReference,
              paymentAttemptReference,
              operationReference,
              auditReference: refundLegReference(
                result.requestReference,
                "operation-audit:" + paymentAttemptReference,
              ),
              approvalReference: null,
            },
          });
          prepared.push(Object.freeze({ paymentAttemptReference, operationReference }));
        } catch {
          // Left to the browser's own prepare, which says why when it is refused.
        }
      }
    }
    return Object.freeze({ ...result, prepared: Object.freeze(prepared) });
  };
}
/** A request leg's stable reference (the approval's derivation, keyed by the request). */
export function refundLegReference(requestReference: string, purpose: string): string {
  return approvalDerivedReference(requestReference, "request:" + purpose);
}
