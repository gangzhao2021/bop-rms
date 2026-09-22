import { createHash } from "node:crypto";
import { parseOrderExceptionSource } from "../../packages/bop/projection/src/index.ts";
import { createPostgresOrderClosureHistory } from "../../packages/rms/ordering/src/index.ts";
import { createOrderClosureFinalityEvidence } from "../../apps/api/dist/order-closure-finality-evidence.js";
import {
  createDiningExceptionEpisodeResolution,
  parseDiningReference,
} from "../../packages/rms/dining/src/index.ts";
import { createInternalDiningExceptionPageRunner } from "./pilot-dining-exceptions.mjs";
/** Read original episode outcomes in the same transaction as current Task/association. */
export function createInternalDiningExceptionEpisodePageRunner(
  { resources, providerAccountReference },
  consume,
) {
  const account = String(parseDiningReference(providerAccountReference));
  const deny = () => {
    throw Error("INTERNAL_DINING_EXCEPTION_EPISODES_UNAVAILABLE");
  };
  return createInternalDiningExceptionPageRunner(
    resources,
    async ({ tx, page, scope, authorize }) => {
      const resolveItem = async ({ task, association }) => {
        const query = { orderReference: association.orderReference, observedAt: page.observedAt };
        const allowed = (t, q) =>
          t === tx &&
          authorize() &&
          q.orderReference === query.orderReference &&
          q.observedAt === query.observedAt;
        const taskAllowed = (t, value) =>
          t === tx && authorize() && JSON.stringify(value) === JSON.stringify(task);
        const history = await createPostgresOrderClosureHistory({
          ...scope,
          authorize: async (t, q) => allowed(t, q),
        })(tx, query);
        if (
          history.position.tenantReference !== scope.tenantReference ||
          history.position.brandReference !== scope.brandReference ||
          history.position.storeReference !== scope.storeReference ||
          history.position.orderReference !== query.orderReference ||
          history.position.observedAt !== query.observedAt
        )
          return deny();
        const readFinality = createOrderClosureFinalityEvidence({
          scope,
          providerAccountReference: account,
          environment: "Test",
          authorize: async (t, q) => allowed(t, q),
        });
        const resolver = createDiningExceptionEpisodeResolution({
          scope,
          authorize: async (t, value) => taskAllowed(t, value),
          association: async (t, q) => {
            if (!taskAllowed(t, q.task) || q.observedAt !== query.observedAt) return deny();
            return association;
          },
          closure: async (t, q) => {
            if (!allowed(t, q) || q.requestedAt !== association.requestedAt) return deny();
            for (const candidate of history.records) {
              if (candidate.status !== "Closed" || candidate.occurredAt <= q.requestedAt) continue;
              const evidence = await readFinality(tx, {
                ...query,
                closureReference: candidate.closureReference,
              });
              if (!evidence || JSON.stringify(evidence.closure) !== JSON.stringify(candidate))
                return deny();
              if (evidence.finality.decidedAt <= q.requestedAt) continue;
              return {
                ...scope,
                ...query,
                orderVersion: evidence.closure.orderVersion,
                closureReference: evidence.closure.closureReference,
                closureVersion: evidence.closure.closureVersion,
                closedAt: evidence.closure.occurredAt,
                ownerFinalityReference: evidence.finality.finalityReference,
                ownerDecidedAt: evidence.finality.decidedAt,
              };
            }
            return null;
          },
        });
        const episode = await resolver.resolve(tx, {
          task,
          ...query,
          expectedOrderVersion: history.position.orderVersion,
        });
        if (!authorize()) return deny();
        if (!["ResolvedEpisode", "UnresolvedEpisode"].includes(episode.outcome)) return deny();
        const resolved = episode.outcome === "ResolvedEpisode";
        const fields = {
          sourceReference: association.taskReference,
          ...scope,
          orderReference: association.orderReference,
          paymentReference: null,
          diningReference: association.diningSessionReference,
          kind: "DiningUnpaidBatch",
          severity: "Critical",
          sourceOwner: "Dining",
          sourceStatus: resolved ? "Final" : "Open",
          providerState: "NotApplicable",
          compensationStatus: "NotRequested",
          sourceVersion: resolved ? 2n : 1n,
          createdAt: association.requestedAt,
          updatedAt: resolved ? episode.resolvedAt : association.requestedAt,
          resolutionEvidenceReference: resolved ? episode.ownerFinalityReference : null,
        };
        const source = parseOrderExceptionSource({
          ...fields,
          sourceDigest:
            "sha256:" +
            createHash("sha256")
              .update(
                JSON.stringify(fields, (_key, value) =>
                  typeof value === "bigint" ? value.toString() : value,
                ),
              )
              .digest("hex"),
        });
        return Object.freeze({ task, association, episode, source });
      };
      const items = [];
      for (const item of page.items) items.push(await resolveItem(item));
      const resolvedPage = Object.freeze({ ...page, items: Object.freeze(items) });
      const output = await consume({
        tx,
        scope,
        page: resolvedPage,
        authorize,
        rereadSource: async (reference) => {
          if (!authorize()) return deny();
          const item = page.items.find((value) => value.association.taskReference === reference);
          if (!item) return deny();
          return (await resolveItem(item)).source;
        },
      });
      if (!authorize()) return deny();
      return output;
    },
  );
}

export function createInternalDiningExceptionEpisodes(options) {
  return createInternalDiningExceptionEpisodePageRunner(options, ({ page }) => page);
}
