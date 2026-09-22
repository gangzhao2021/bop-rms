import {
  createPostgresOrderExceptionSourceStore,
  parseOrderExceptionSource,
} from "../../packages/bop/projection/src/index.ts";
import { createInternalDiningExceptionEpisodePageRunner } from "./pilot-dining-exception-episodes.mjs";
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
/** One bounded recovery page; progress is committed only after all writes succeed. */
export function createInternalDiningProjection(options) {
  let cursor = null;
  const fail = () => {
    throw Error("INTERNAL_DINING_PROJECTION_UNAVAILABLE");
  };
  const run = createInternalDiningExceptionEpisodePageRunner(
    options,
    async ({ tx, page, scope, authorize, rereadSource }) => {
      if (!Array.isArray(page.items) || page.items.length > 5) return fail();
      const sources = page.items.map((item) => parseOrderExceptionSource(item.source));
      let previous = cursor;
      for (const source of sources) {
        if (
          source.kind !== "DiningUnpaidBatch" ||
          source.sourceOwner !== "Dining" ||
          source.tenantReference !== scope.tenantReference ||
          source.brandReference !== scope.brandReference ||
          source.storeReference !== scope.storeReference ||
          (previous !== null && source.sourceReference <= previous)
        )
          return fail();
        previous = source.sourceReference;
      }
      if (
        page.nextAfterTaskReference !== null &&
        (sources.length !== 5 || page.nextAfterTaskReference !== previous)
      )
        return fail();
      const store = createPostgresOrderExceptionSourceStore({
        scope,
        authorize: async (t) => t === tx && authorize(),
        validateSource: async (t, source) =>
          t === tx &&
          authorize() &&
          json(parseOrderExceptionSource(await rereadSource(source.sourceReference))) ===
            json(source),
      });
      for (const source of sources)
        await store.write(tx, source, options.resources.credentials.reference());
      return { next: page.nextAfterTaskReference, projectedCount: sources.length };
    },
  );
  return async () => {
    const result = await run({ afterTaskReference: cursor, limit: 5 });
    cursor = result.next;
    return { projectedCount: result.projectedCount, scanComplete: cursor === null };
  };
}
