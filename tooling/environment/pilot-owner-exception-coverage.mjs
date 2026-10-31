import { parseOrderExceptionSource } from "../../packages/bop/projection/src/index.ts";
import { createInternalDiningExceptionEpisodePageRunner } from "./pilot-dining-exception-episodes.mjs";
import { createInternalReconciliationExceptionPageRunner } from "./pilot-reconciliation-exceptions.mjs";
import { mapInternalReconciliationSource } from "./pilot-reconciliation-projection.mjs";
import { COVERAGE_PAGE_LIMIT, projectedReferences } from "./pilot-exception-references.mjs";
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
/**
 * WP-2423: the owner's cases are paged by reference; a case is resolved (owner reads) only when
 * the page shows it (`select`), so the reads grow with the open cases, not the Store's lifetime
 * count. Every owner case must be projected, each shown case must equal its owner's current state,
 * and a projected case not shown must be final (Final is terminal and was checked against the owner
 * when written).
 */
function createCoverage(resources, kind, makeRunner, cursorKey, nextKey, convert, pageSize = 100) {
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  return async ({ tx, projected, references, authorize }) => {
    const fail = () => {
      throw Error("INTERNAL_OWNER_EXCEPTION_COVERAGE_UNAVAILABLE");
    };
    const active = async () =>
      resources.now() < resources.publicProfile.binding.validUntil && (await authorize(tx));
    if (!(await active())) return fail();
    const isolation = await tx.query(
      "SELECT current_setting('transaction_isolation') AS isolation",
      [],
    );
    if (
      isolation.rows.length !== 1 ||
      !["repeatable read", "serializable"].includes(isolation.rows[0].isolation)
    )
      return fail();
    if (!Array.isArray(projected) || projected.length > 2000) return fail();
    const expected = new Map();
    for (const raw of projected) {
      const source = parseOrderExceptionSource(raw);
      if (Object.keys(scope).some((key) => source[key] !== scope[key])) return fail();
      if (source.kind !== kind) continue;
      if (expected.has(source.sourceReference)) return fail();
      expected.set(source.sourceReference, source);
    }
    const known = projectedReferences(kind, references, expected, fail);
    const bound = {
      ...resources,
      transactions: {
        run: async (work) => {
          if (!(await active())) return fail();
          return work(tx);
        },
      },
    };
    const run = makeRunner(bound, async (context) => {
      if (
        context.tx !== tx ||
        !context.authorize() ||
        Object.keys(scope).some((key) => context.scope[key] !== scope[key])
      )
        return fail();
      if (!Array.isArray(context.page.items) || context.page.items.length > pageSize) return fail();
      const items = [];
      for (const item of context.page.items) {
        if (item?.skipped === true) {
          if (typeof item.reference !== "string") return fail();
          items.push(Object.freeze({ sourceReference: item.reference, skipped: true }));
          continue;
        }
        items.push(parseOrderExceptionSource(await convert(item, context.scope, context.tx)));
      }
      for (const source of items)
        if (
          !source.skipped &&
          (source.kind !== kind ||
            Object.keys(scope).some((key) => source[key] !== scope[key]) ||
            source.updatedAt > resources.now())
        )
          return fail();
      return { items, next: context.page[nextKey] };
    });
    let cursor = null,
      count = 0;
    const seen = new Set();
    for (let pageNumber = 0; pageNumber < COVERAGE_PAGE_LIMIT; pageNumber++) {
      if (!(await active())) return fail();
      const page = await run({
        [cursorKey]: cursor,
        limit: pageSize,
        select: (reference) => expected.has(reference),
      });
      let previous = cursor;
      for (const source of page.items) {
        if (previous !== null && source.sourceReference <= previous) return fail();
        previous = source.sourceReference;
        if (!known.has(source.sourceReference)) return { complete: false, sourceCount: count };
        seen.add(source.sourceReference);
        count++;
        if (source.skipped || !expected.has(source.sourceReference)) {
          // Not shown: only a final case may be left unread; a projected open case is always shown.
          if (expected.has(source.sourceReference) || known.get(source.sourceReference) !== true)
            return { complete: false, sourceCount: count };
          continue;
        }
        if (json(source) !== json(expected.get(source.sourceReference)))
          return { complete: false, sourceCount: count };
      }
      if (page.next === null) {
        if (!(await active())) return fail();
        return Object.freeze({
          complete: [...known.keys()].every((reference) => seen.has(reference)),
          sourceCount: count,
        });
      }
      if (page.items.length !== pageSize || page.next !== previous) return fail();
      cursor = previous;
    }
    return fail();
  };
}
export function createInternalDiningCoverage({ resources, providerAccountReference, pageSize }) {
  return createCoverage(
    resources,
    "DiningUnpaidBatch",
    (bound, consume) =>
      createInternalDiningExceptionEpisodePageRunner(
        { resources: bound, providerAccountReference },
        consume,
      ),
    "afterTaskReference",
    "nextAfterTaskReference",
    (item) => item.source,
    pageSize,
  );
}
export function createInternalReconciliationCoverage(resources, { pageSize } = {}) {
  return createCoverage(
    resources,
    "PaymentReconciliationDifference",
    createInternalReconciliationExceptionPageRunner,
    "afterExceptionReference",
    "nextAfterExceptionReference",
    mapInternalReconciliationSource,
    pageSize,
  );
}
