import { parsePickupExecution, parsePickupReference, type PickupQueueItem } from "./pickup.js";

export class PickupProofClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "PermissionDenied"
      | "Conflict"
      | "Rejected"
      /** WP-2423: five wrong codes locked code checks; check the customer in person. */
      | "Locked"
      | "OutcomeUnknown",
  ) {
    super("Pickup proof verification could not be confirmed");
    this.name = "PickupProofClientError";
  }
}
function fail(code: PickupProofClientError["code"]): never {
  throw new PickupProofClientError(code);
}
export interface PickupVerification {
  readonly verificationReference: string;
  readonly fulfillmentReference: string;
  readonly expectedAggregateVersion: string;
  readonly generation: number;
  readonly grantsCompletionAuthority: false;
}
/** Credential exists only in this disposable in-memory intent, never browser storage. */
export function createPickupProofClient(fetcher: typeof fetch = fetch) {
  return {
    prepare(input: {
      item: PickupQueueItem;
      storeReference: string;
      credential: string;
      idempotencyReference: string;
      correlationReference: string;
    }) {
      let command: Record<string, unknown>, expectedVersion: string;
      try {
        const execution = parsePickupExecution(input.item.execution),
          proof = execution.proof;
        if (!proof || input.item.phase !== "Ready" || input.item.proofReadiness !== "Ready")
          return fail("Invalid");
        // WP-2423 (DEC-PICKUP-COUNTER-CODE): staff type the six-digit code (spaces or dashes are
        // ignored); a scanner may still enter the long code.
        const typed = input.credential.trim().replace(/[\s-]/gu, "");
        const kind = /^[0-9]{6}$/.test(typed)
          ? "HumanCode"
          : proof.kind === "Opaque" && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(input.credential.trim())
            ? "Opaque"
            : null;
        if (kind === null) return fail("Invalid");
        expectedVersion = execution.aggregateVersion;
        command = {
          orderReference: parsePickupReference(input.item.orderReference),
          storeReference: parsePickupReference(input.storeReference),
          fulfillmentReference: parsePickupReference(input.item.fulfillmentReference),
          kind,
          generation: proof.generation,
          credential: kind === "HumanCode" ? typed : input.credential.trim(),
          idempotencyReference: parsePickupReference(input.idempotencyReference),
          correlationReference: parsePickupReference(input.correlationReference),
        };
      } catch {
        return fail("Invalid");
      }
      const target = command.fulfillmentReference,
        generation = command.generation;
      let body: string | null = JSON.stringify(command),
        inFlight = false;
      // Do not retain a second copy in the parsed command.
      command.credential = undefined;
      return Object.freeze({
        dispose() {
          body = null;
        },
        async execute(csrf: string, signal?: AbortSignal): Promise<PickupVerification> {
          if (!body || inFlight || signal?.aborted || !/^[A-Za-z0-9_-]{43}$/.test(csrf))
            return fail("Invalid");
          inFlight = true;
          const controller = new AbortController(),
            abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(abort, 15000);
          try {
            const response = await fetcher("/merchant/pickup/proof", {
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
            if (response.status === 423) return fail("Locked");
            if (response.status === 404) return fail("Conflict");
            if (response.status === 422) {
              // Only a recorded wrong code is "Rejected"; an expired or replaced proof is a change.
              let error: unknown = null;
              try {
                const text = await response.text();
                if (text.length <= 1024) error = (JSON.parse(text) as { error?: unknown }).error;
              } catch {
                error = null;
              }
              return fail(error === "PICKUP_PROOF_REJECTED" ? "Rejected" : "Conflict");
            }
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
              Object.keys(r).length !== 6 ||
              !["Applied", "AlreadyApplied"].includes(String(r.status)) ||
              r.fulfillmentReference !== target ||
              r.generation !== generation ||
              r.grantsCompletionAuthority !== false ||
              typeof r.expectedAggregateVersion !== "string" ||
              !/^[1-9][0-9]{0,18}$/.test(r.expectedAggregateVersion) ||
              BigInt(r.expectedAggregateVersion) > 9223372036854775807n ||
              BigInt(r.expectedAggregateVersion) < BigInt(expectedVersion)
            )
              return fail("OutcomeUnknown");
            const verificationReference = parsePickupReference(r.verificationReference);
            body = null;
            return Object.freeze({
              verificationReference,
              fulfillmentReference: String(target),
              expectedAggregateVersion: r.expectedAggregateVersion,
              generation: Number(generation),
              grantsCompletionAuthority: false,
            });
          } catch (error) {
            if (error instanceof PickupProofClientError) {
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
