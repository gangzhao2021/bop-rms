import { createHash, randomUUID } from "node:crypto";
import { createMerchantKitchenCommand } from "../../apps/api/dist/merchant-kitchen-command.js";
import {
  createPostgresKitchenQueueSourceReader,
  createPostgresKitchenTicketStore,
} from "../../packages/rms/kitchen/src/index.ts";
import { createPostgresOrderKitchenSourceStore } from "../../packages/rms/ordering/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
export function createInternalKitchenCommand(resources, persistence, authentication) {
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
  const sourceReader = createPostgresKitchenQueueSourceReader({
    ...scope,
    maxTickets: 100,
    maxItemsPerTicket: 100,
    maxOperationsPerTicket: 1000,
    creationValidation: { references: refs, digests: { sha256: hash } },
    lifecycleValidation: { references: refs, digests: { sha256: hash } },
    nextSnapshotReference: refs.next,
    authorize: async () => active(),
  });
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
  return createMerchantKitchenCommand({
    persistence,
    authentication,
    lifecycle,
    validateCurrentSource: async (transaction, command) => {
      if (!allowed(command)) return false;
      const feed = await sourceReader.read(transaction),
        entry = feed.tickets.find((t) => t.ticketReference === command.ticketReference);
      if (!entry || !entry.items.some((i) => i.orderItemReference === command.orderItemReference))
        return false;
      const original = await creation.resolveBySemanticKeys({
        transaction,
        ...scope,
        sourceEventReference: entry.sourceEvent.causationId,
        confirmationReference: entry.sourceEvent.payload.confirmationReference,
        orderBatchReference: entry.orderBatchReference,
      });
      if (original.status !== "Resolved") return false;
      const ticket = original.effect.ticket;
      const current = await orderSource.resolve({
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
      return current.evidenceDigest === ticket.sourceEvidenceDigest;
    },
  });
}
