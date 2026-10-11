import {
  createPostgresStoreBusinessDateConfigurationSource,
  createPostgresStoreClosedBusinessDateWindowSource,
  createPostgresAsPublishedStorePublicationProof,
  resolveStoreBusinessDate,
} from "../../packages/rms/store/src/index.ts";

/** Fully closed Store day before an owner boundary, defaulting to the latest closed day. */
export function createInternalClosedSettlementWindow({ resources, active }) {
  const { scope, operating, transactions } = resources;
  const authorize = async (tx, at) =>
    (await active()) === true && (await operating.authorize(tx, at)) === true;
  const sourceOptions = {
    ...scope,
    timeZone: operating.timeZone,
    authorize,
    // Past instants (prior day, backlog back to the first coverage window) verify each
    // configuration against the release that published it, not the newest release:
    // a later hours publication must not make earlier settlement days unreadable.
    publicationProof: async (tx, candidate, observedAt) => {
      const proof = await createPostgresAsPublishedStorePublicationProof({
        ...operating,
        authorize,
        configurationReference: candidate.configurationReference,
      })(tx, observedAt);
      return {
        contentDigest: proof.contentDigest,
        businessDayStartSource: proof.businessDayStartSource,
      };
    },
  };
  const read = createPostgresStoreBusinessDateConfigurationSource(sourceOptions);
  // Owner closed-day read: every version governing the day, identical boundaries required.
  const readWindow = createPostgresStoreClosedBusinessDateWindowSource(sourceOptions);
  return async (input = undefined) => {
    if ((await active()) !== true) throw Error("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
    const observedAt = resources.now();
    if (
      input !== undefined &&
      (!input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).join(",") !== "endingAt" ||
        typeof input.endingAt !== "string" ||
        !Number.isFinite(Date.parse(input.endingAt)) ||
        new Date(input.endingAt).toISOString() !== input.endingAt ||
        input.endingAt > observedAt)
    )
      throw Error("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
    const anchorAt = input?.endingAt ?? observedAt;
    return transactions.run(async (tx) => {
      const currentConfiguration = await read(tx, anchorAt);
      const current = resolveStoreBusinessDate({
        occurredAt: anchorAt,
        configuration: currentConfiguration,
      });
      if (input !== undefined && current.businessDateBoundaryAt !== anchorAt)
        throw Error("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
      const priorAt = new Date(Date.parse(current.businessDateBoundaryAt) - 1).toISOString();
      const prior = resolveStoreBusinessDate({
        occurredAt: priorAt,
        configuration: await read(tx, priorAt),
      });
      const window = await readWindow(tx, {
        businessDate: prior.businessDate,
        anchorAt: priorAt,
        observedAt,
      });
      if (window.endsAt !== current.businessDateBoundaryAt || (await active()) !== true)
        throw Error("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
      return window;
    });
  };
}
