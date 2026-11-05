import type { ConsumerTransaction } from "@bop/eventing";
import {
  chunkKitchenWorkStepLines,
  KitchenWorkLifecycleError,
  kitchenWorkStepNotAttempted,
  kitchenWorkStepReplyHead,
  parseKitchenWorkStepBody,
  runKitchenWorkStepChunk,
  type KitchenWorkLifecyclePorts,
  type KitchenWorkStepLineResult,
  type KitchenWorkStepReply,
} from "@rms/kitchen";
import { comboChoiceProducts } from "./merchant-combo-parts.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * DEC-KITCHEN-ONE-TAP: one tap on the kitchen board. Same session rule (a named kitchen display),
 * permission (kitchen.operate) and Store scope as /kitchen/work. The tap's lines run in chunks, each
 * its own authorized transaction, because the Store-wide audit head stays locked from a chunk's first
 * recorded fact to its commit. The rule itself lives in @rms/kitchen; this only composes it.
 */
export function createMerchantKitchenStep(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  lifecycle: Pick<
    KitchenWorkLifecyclePorts,
    "admission" | "expo" | "references" | "digests" | "tenantContext" | "idempotency"
  >;
  /** Whether the Order still stands behind this ticket; holds its fence and row lock. */
  validateTicketSource(transaction: ConsumerTransaction, ticketReference: string): Promise<boolean>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const denied = (): never => {
    throw new KitchenWorkLifecycleError("KITCHEN_WORK_PERMISSION_DENIED");
  };
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    body: unknown;
  }): Promise<KitchenWorkStepReply> => {
    const session = await options.authentication.authorize(input);
    if (session?.policy?.code !== "NamedKdsOperator") return denied();
    const body = parseKitchenWorkStepBody(input.body);
    const chunks = chunkKitchenWorkStepLines(body.lines);
    const tapTickets = [...new Set(body.lines.map((line) => line.ticketReference))];
    const results: KitchenWorkStepLineResult[] = [];
    let occurredAt: string | null = null;
    let failed = false;
    for (const lines of chunks) {
      if (failed) {
        results.push(...lines.map(kitchenWorkStepNotAttempted));
        continue;
      }
      try {
        const chunk = await retryTransactionConflict(() =>
          options.persistence.transactions.run((transaction) =>
            withMerchantTransactionAuthorization(
              {
                transaction,
                resolve: async () => {
                  const resolved = await resolveScope(
                    transaction,
                    input.sessionCookie,
                    "kitchen.operate",
                    session.sessionReference,
                  );
                  if ((await resolved.allowed()) !== true) return denied();
                  // A tablet whose selected Store changed in another tab is refused, not ignored.
                  if (resolved.store.storeReference !== body.storeReference) return denied();
                  return resolved;
                },
                recheck: async (scope) => (await scope.allowed()) === true,
                denied,
              },
              async (authority) => {
                const scope = authority.scope;
                const tx = transaction as unknown as ConsumerTransaction;
                authority.bind(tx);
                const owners = {
                  brandReference: String(scope.context.brand.brandReference),
                  storeReference: String(scope.store.storeReference),
                };
                return runKitchenWorkStepChunk(
                  {
                    ...options.lifecycle,
                    ...owners,
                    actorReference: String(scope.actorReference),
                    now: options.persistence.now,
                    guard: (candidate) => authority.guard(candidate),
                    validateTicketSource: options.validateTicketSource,
                    comboChoices: (candidate, optionReferences) =>
                      comboChoiceProducts(candidate as never, owners, optionReferences),
                  },
                  {
                    transaction: tx,
                    step: body.step,
                    correlationReference: body.correlationReference,
                    tapTickets,
                    lines,
                  },
                );
              },
            ),
          ),
        );
        occurredAt = chunk.occurredAt;
        results.push(...chunk.lines);
      } catch (error) {
        // Nothing of this chunk committed. With nothing committed at all the tap failed as a whole;
        // otherwise the reply says what happened and the same body resumes safely.
        if (occurredAt === null) throw error;
        failed = true;
        results.push(...lines.map(kitchenWorkStepNotAttempted));
      }
    }
    if (occurredAt === null) throw new KitchenWorkLifecycleError("KITCHEN_WORK_INPUT_INVALID");
    // The reply keeps the tap's own order of lines, whatever the chunks were.
    const byWorkItem = new Map(results.map((line) => [line.workItemReference, line]));
    return Object.freeze({
      ...kitchenWorkStepReplyHead,
      occurredAt,
      lines: Object.freeze(
        body.lines.map(
          (line) => byWorkItem.get(line.workItemReference) ?? kitchenWorkStepNotAttempted(line),
        ),
      ),
    });
  };
}
