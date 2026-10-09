import type { PickupVerification } from "./pickup-proof-client.js";
import {
  parsePickupExecution,
  parsePickupReference,
  parsePickupWorkstation,
  type PickupWorkstation,
  type PickupQueueItem,
} from "./pickup.js";

export class PickupHandoffClientError extends Error {
  constructor(
    readonly code: "Invalid" | "PermissionDenied" | "Conflict" | "Rejected" | "OutcomeUnknown",
  ) {
    super("Pickup handoff could not be confirmed");
    this.name = "PickupHandoffClientError";
  }
}
function fail(code: PickupHandoffClientError["code"]): never {
  throw new PickupHandoffClientError(code);
}
export interface PickupHandoffResult {
  readonly handoffReference: string;
  readonly fulfillmentReference: string;
  readonly nextAggregateVersion: string;
  readonly nextPhase: "InProgress" | "Completed";
}
/** One immutable handoff intent; uncertain responses require explicit same-key retry. */
export function createPickupHandoffClient(fetcher: typeof fetch = fetch) {
  return {
    prepare(input: {
      item: PickupQueueItem;
      storeReference: string;
      /** Null for an in-person check (the proof expired or was never issued). */
      verification: PickupVerification | null;
      identityCheck?: "OrderNumberAndName" | "OrderNumberAndPhoneLast4";
      workstation: PickupWorkstation;
      recipientType: "Customer" | "Delegate";
      recipientDisplayMask: string;
      idempotencyReference: string;
      correlationReference: string;
    }) {
      let command: Record<string, unknown>, expectedVersion: string;
      try {
        const execution = parsePickupExecution(input.item.execution),
          workstation = parsePickupWorkstation(input.workstation),
          verification = input.verification;
        if (
          !workstation ||
          input.item.phase !== "Ready" ||
          (verification === null
            ? !["Expired", "NotIssued"].includes(input.item.proofReadiness) ||
              (input.identityCheck !== "OrderNumberAndName" &&
                input.identityCheck !== "OrderNumberAndPhoneLast4")
            : !execution.proof ||
              verification.fulfillmentReference !== input.item.fulfillmentReference ||
              verification.generation !== execution.proof.generation ||
              verification.grantsCompletionAuthority !== false ||
              verification.expectedAggregateVersion !== execution.aggregateVersion) ||
          !["Customer", "Delegate"].includes(input.recipientType) ||
          !/^[\p{L}\p{N}* ._'()-]{1,64}$/u.test(input.recipientDisplayMask)
        )
          return fail("Invalid");
        const quantities = execution.items
          .filter((line) => line.readyQuantity > line.handedOverQuantity)
          .map((line) => ({
            fulfillmentItemReference: line.fulfillmentItemReference,
            quantity: line.readyQuantity - line.handedOverQuantity,
          }));
        if (!quantities.length) return fail("Invalid");
        expectedVersion = execution.aggregateVersion;
        command = {
          orderReference: parsePickupReference(input.item.orderReference),
          storeReference: parsePickupReference(input.storeReference),
          fulfillmentReference: parsePickupReference(input.item.fulfillmentReference),
          expectedAggregateVersion: expectedVersion,
          ...(verification === null
            ? { identityCheck: input.identityCheck }
            : { verificationReference: parsePickupReference(verification.verificationReference) }),
          ...workstation,
          quantities,
          recipientType: input.recipientType,
          recipientDisplayMask: input.recipientDisplayMask,
          idempotencyReference: parsePickupReference(input.idempotencyReference),
          correlationReference: parsePickupReference(input.correlationReference),
        };
      } catch {
        return fail("Invalid");
      }
      const target = command.fulfillmentReference;
      let body: string | null = JSON.stringify(command),
        inFlight = false;
      return Object.freeze({
        dispose() {
          body = null;
        },
        async execute(csrf: string, signal?: AbortSignal): Promise<PickupHandoffResult> {
          if (!body || inFlight || signal?.aborted || !/^[A-Za-z0-9_-]{43}$/.test(csrf))
            return fail("Invalid");
          inFlight = true;
          const controller = new AbortController(),
            abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(abort, 15000);
          try {
            const response = await fetcher("/merchant/pickup/handoff", {
              method: "POST",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-BOP-CSRF": csrf,
              },
              body,
              signal: controller.signal,
            });
            if (controller.signal.aborted || body === null) return fail("OutcomeUnknown");
            if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
            if (response.status === 409) return fail("Conflict");
            if (response.status === 404 || response.status === 422) return fail("Rejected");
            if (response.status === 400) return fail("Invalid");
            if (
              !response.ok ||
              response.headers.get("cache-control") !== "no-store" ||
              !response.headers.get("content-type")?.startsWith("application/json")
            )
              return fail("OutcomeUnknown");
            const text = await response.text();
            if (controller.signal.aborted || body === null || text.length > 16384)
              return fail("OutcomeUnknown");
            const raw: unknown = JSON.parse(text);
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              return fail("OutcomeUnknown");
            const r = raw as Record<string, unknown>;
            if (
              Object.keys(r).length !== 5 ||
              !["Applied", "AlreadyApplied"].includes(String(r.status)) ||
              r.fulfillmentReference !== target ||
              !["InProgress", "Completed"].includes(String(r.nextPhase)) ||
              typeof r.nextAggregateVersion !== "string" ||
              !/^[1-9][0-9]{0,18}$/.test(r.nextAggregateVersion) ||
              BigInt(r.nextAggregateVersion) > 9223372036854775807n ||
              BigInt(r.nextAggregateVersion) <= BigInt(expectedVersion)
            )
              return fail("OutcomeUnknown");
            const handoffReference = parsePickupReference(r.handoffReference);
            body = null;
            return Object.freeze({
              handoffReference,
              fulfillmentReference: String(target),
              nextAggregateVersion: r.nextAggregateVersion,
              nextPhase: r.nextPhase as PickupHandoffResult["nextPhase"],
            });
          } catch (error) {
            if (error instanceof PickupHandoffClientError) {
              if (error.code !== "OutcomeUnknown") body = null;
              throw error;
            }
            return fail("OutcomeUnknown");
          } finally {
            inFlight = false;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
          }
        },
      });
    },
  };
}
