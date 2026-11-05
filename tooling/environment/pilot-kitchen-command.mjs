import { createHash, randomUUID } from "node:crypto";
import { kitchenNotPreparedLines } from "./pilot-kitchen.mjs";
import { createMerchantKitchenCommand } from "../../apps/api/dist/merchant-kitchen-command.js";
import { createMerchantKitchenStep } from "../../apps/api/dist/merchant-kitchen-step.js";
import {
  createPostgresKitchenTicketStore,
  listClosedKitchenTickets,
} from "../../packages/rms/kitchen/src/index.ts";
import { createPostgresOrderKitchenSourceStore } from "../../packages/rms/ordering/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
function createKitchenSource(resources) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_KITCHEN_ONLY");
  const scope = resources.scope,
    active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const refs = {
    next: () => {
      const d = randomUUID().replaceAll("-", "");
      return (
        "0190fa37-" +
        d.slice(0, 4) +
        "-7" +
        d.slice(4, 7) +
        "-8" +
        d.slice(7, 10) +
        "-" +
        d.slice(10, 22)
      );
    },
    derive: (purpose, identity) => {
      const d = hash(purpose + ":" + identity).slice(7);
      return (
        "0190fa35-" +
        d.slice(0, 4) +
        "-7" +
        d.slice(4, 7) +
        "-8" +
        d.slice(7, 10) +
        "-" +
        d.slice(10, 22)
      );
    },
  };
  const allowed = (input) =>
    active() &&
    input.brandReference === scope.brandReference &&
    input.storeReference === scope.storeReference;
  const creation = createPostgresKitchenTicketStore({
    ...scope,
    references: refs,
    digests: { sha256: hash },
    authorize: async () => active(),
    validateCurrentSource: async () => false,
  });
  const orderSource = createPostgresOrderKitchenSourceStore({
    ...scope,
    quoteVersion: 2,
    sha256: hash,
    authorize: async () => active(),
    // WP-2423 item 8 ⑦: the round's source as the kitchen took it (without dishes it doesn't make).
    notPrepared: kitchenNotPreparedLines(scope),
  });
  const lifecycle = {
    references: refs,
    digests: { sha256: hash },
    tenantContext: {
      install: async (input) => {
        if (!allowed(input)) throw new Error("INTERNAL_KITCHEN_SCOPE_DENIED");
      },
    },
    idempotency: {
      acquireFence: async ({ transaction, idempotencyKey, ...input }) => {
        if (!allowed(input)) throw new Error("INTERNAL_KITCHEN_SCOPE_DENIED");
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          scope.brandReference + ":" + scope.storeReference + ":" + idempotencyKey,
        ]);
      },
    },
    admission: {
      resolve: async ({ command, acceptedOperationReference, observedAt }) => {
        if (!allowed(command)) return null;
        return {
          decisionReference: refs.next(),
          decisionVersion: 1,
          decisionDigest: hash("INTERNAL_TEST_START_ALLOWED"),
          producerContractVersion: 1,
          actorReference: command.actorReference,
          ...scope,
          ticketReference: command.ticketReference,
          workItemReference: command.workItemReference,
          acceptedOperationReference,
          ticketVersion: BigInt(command.expectedTicketVersion),
          workItemVersion: BigInt(command.expectedWorkItemVersion),
          action: "StartKitchenWorkItem",
          purpose: "KitchenWorkExecution",
          outcome: "Allowed",
          evaluatedAt: observedAt,
          validUntil: new Date(
            Math.min(
              Date.parse(observedAt) + 60000,
              Date.parse(resources.publicProfile.binding.validUntil),
            ),
          ).toISOString(),
        };
      },
    },
    expo: {
      resolve: async (input) => {
        if (!allowed(input)) return null;
        return {
          decisionReference: refs.next(),
          decisionVersion: 1,
          decisionDigest: hash("INTERNAL_TEST_EXPO_DISABLED"),
          producerContractVersion: 1,
          ...scope,
          purpose: "KitchenReadiness",
          mode: "Disabled",
          evaluatedAt: input.observedAt,
          validUntil: new Date(
            Math.min(
              Date.parse(input.observedAt) + 60000,
              Date.parse(resources.publicProfile.binding.validUntil),
            ),
          ).toISOString(),
        };
      },
    },
  };
  /**
   * DEC-KITCHEN-ONE-TAP: one issued ticket's current source, instead of reading and decoding every
   * ticket of the Store's last day for each step (it cost a whole-Store read six times per tap and
   * failed every step past the feed's limit). The Order's fence and row lock stay held to the end
   * of the transaction, as before.
   */
  const ticketSourceHolds = async (transaction, ticketReference) => {
    const closed = await listClosedKitchenTickets(transaction, scope, [ticketReference]);
    if (closed.size > 0) return null;
    const original = await creation.resolveByTicket({ transaction, ticketReference });
    if (original.status !== "Resolved") return null;
    const ticket = original.effect.ticket;
    // Issued work stays current across later staff item cancellations (remaining lines unchanged).
    const current = await orderSource.resolveIssued({
      transaction,
      query: {
        ...scope,
        orderReference: ticket.orderReference,
        orderBatchReference: ticket.orderBatchReference,
        confirmationReference: ticket.confirmationReference,
        sourceEventReference: ticket.sourceEventReference,
        sourceAggregateVersion: ticket.sourceAggregateVersion,
        sourceSnapshotDigest: ticket.sourceSnapshotDigest,
        observedAt: resources.now(),
      },
    });
    return current.evidenceDigest === ticket.sourceEvidenceDigest ? ticket : null;
  };
  return {
    lifecycle,
    allowed,
    ticketSourceHolds,
  };
}

export function createInternalKitchenCommand(resources, persistence, authentication) {
  const { lifecycle, allowed, ticketSourceHolds } = createKitchenSource(resources);
  return createMerchantKitchenCommand({
    persistence,
    authentication,
    lifecycle,
    validateCurrentSource: async (transaction, command) => {
      if (!allowed(command)) return false;
      const ticket = await ticketSourceHolds(transaction, command.ticketReference);
      return (
        ticket !== null &&
        ticket.workItems.some((item) => item.orderItemReference === command.orderItemReference)
      );
    },
  });
}

/** DEC-KITCHEN-ONE-TAP: one tap on the board (POST /merchant/kitchen/step). */
export function createInternalKitchenStep(resources, persistence, authentication) {
  const { lifecycle, ticketSourceHolds } = createKitchenSource(resources);
  return createMerchantKitchenStep({
    persistence,
    authentication,
    lifecycle,
    validateTicketSource: async (transaction, ticketReference) =>
      (await ticketSourceHolds(transaction, ticketReference)) !== null,
  });
}
