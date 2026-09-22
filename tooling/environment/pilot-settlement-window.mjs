import {
  createPostgresStoreBusinessDateConfigurationSource,
  createPostgresCurrentStorePublicationProof,
  resolveStoreBusinessDate,
  resolveClosedStoreBusinessDateWindow,
} from "../../packages/rms/store/src/index.ts";

/** Fully closed Store day before an owner boundary, defaulting to the latest closed day. */
export function createInternalClosedSettlementWindow({ resources, active }) {
  const { scope, operating, transactions } = resources;
  const authorize = async (tx, at) =>
    (await active()) === true && (await operating.authorize(tx, at)) === true;
  const read = createPostgresStoreBusinessDateConfigurationSource({
    ...scope,
    timeZone: operating.timeZone,
    authorize,
    publicationProof: async (tx, candidate, observedAt) => {
      const proof = await createPostgresCurrentStorePublicationProof({
        ...operating,
        authorize,
        configurationReference: candidate.configurationReference,
      })(tx, observedAt);
      return {
        contentDigest: proof.contentDigest,
        businessDayStartSource: proof.businessDayStartSource,
      };
    },
  });
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
      const configuration = await read(tx, priorAt);
      const prior = resolveStoreBusinessDate({ occurredAt: priorAt, configuration });
      const window = resolveClosedStoreBusinessDateWindow({
        businessDate: prior.businessDate,
        observedAt,
        configuration,
      });
      // A newer publication may supersede an open-ended predecessor inside this window.
      for (const at of [window.startsAt, new Date(Date.parse(window.endsAt) - 1).toISOString()]) {
        const endpoint = await read(tx, at);
        if (JSON.stringify(endpoint) !== JSON.stringify(configuration))
          throw Error("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
      }
      if (window.endsAt !== current.businessDateBoundaryAt || (await active()) !== true)
        throw Error("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
      return window;
    });
  };
}
