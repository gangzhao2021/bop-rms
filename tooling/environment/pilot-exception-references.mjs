import { createPostgresOrderExceptionSourceStore } from "../../packages/bop/projection/src/index.ts";

/** Owner pages a coverage check may read (100 cases each, so up to 100 000 cases a kind). */
export const COVERAGE_PAGE_LIMIT = 1000;

/**
 * WP-2423: every case the order-exception projection holds — reference, kind and whether it is
 * final — read from the projection without records, in the caller's snapshot transaction.
 */
export async function readProjectedExceptionReferences({ tx, scope, authorize }) {
  const fail = () => {
    throw Error("INTERNAL_EXCEPTION_REFERENCES_UNAVAILABLE");
  };
  const store = createPostgresOrderExceptionSourceStore({
    scope,
    authorize: async (t, access) => t === tx && access === "Read" && (await authorize(tx)),
    validateSource: async () => false,
  });
  const references = new Map();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const result = await store.listReferences(tx, { afterSourceReference: cursor, limit: 1000 });
    for (const item of result.items) {
      if (references.has(item.sourceReference)) return fail();
      references.set(item.sourceReference, Object.freeze({ kind: item.kind, final: item.final }));
    }
    if (result.nextAfterSourceReference === null) return references;
    if (cursor !== null && result.nextAfterSourceReference <= cursor) return fail();
    cursor = result.nextAfterSourceReference;
  }
  return fail();
}

/**
 * The projected cases of one kind (reference -> final). Without `references` (older callers),
 * the shown sources are the whole projection. Every shown source must be among them.
 */
export function projectedReferences(kind, references, expected, fail) {
  const known = new Map();
  if (references === undefined) {
    for (const [reference, source] of expected)
      known.set(reference, source.sourceStatus === "Final");
    return known;
  }
  if (!(references instanceof Map)) return fail();
  for (const [reference, value] of references)
    if (value?.kind === kind) known.set(reference, value.final === true);
  for (const [reference, source] of expected)
    if (!known.has(reference) || known.get(reference) !== (source.sourceStatus === "Final"))
      return fail();
  return known;
}
