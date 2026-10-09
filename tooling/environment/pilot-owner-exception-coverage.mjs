import { parseOrderExceptionSource } from "../../packages/bop/projection/src/index.ts";
import { createInternalDiningExceptionEpisodePageRunner } from "./pilot-dining-exception-episodes.mjs";
import { createInternalReconciliationExceptionPageRunner } from "./pilot-reconciliation-exceptions.mjs";
import { mapInternalReconciliationSource } from "./pilot-reconciliation-projection.mjs";
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
function createCoverage(resources, kind, makeRunner, cursorKey, nextKey, convert) {
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  return async ({ tx, projected, authorize }) => {
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
    if (!Array.isArray(projected) || projected.length > 500) return fail();
    const expected = new Map();
    for (const raw of projected) {
      const source = parseOrderExceptionSource(raw);
      if (Object.keys(scope).some((key) => source[key] !== scope[key])) return fail();
      if (source.kind !== kind) continue;
      if (expected.has(source.sourceReference)) return fail();
      expected.set(source.sourceReference, source);
    }
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
      if (!Array.isArray(context.page.items) || context.page.items.length > 5) return fail();
      const items = [];
      for (const item of context.page.items)
        items.push(parseOrderExceptionSource(await convert(item, context.scope, context.tx)));
      for (const source of items)
        if (
          source.kind !== kind ||
          Object.keys(scope).some((key) => source[key] !== scope[key]) ||
          source.updatedAt > resources.now()
        )
          return fail();
      return { items, next: context.page[nextKey] };
    });
    let cursor = null,
      count = 0;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      if (!(await active())) return fail();
      const page = await run({ [cursorKey]: cursor, limit: 5 });
      let previous = cursor;
      for (const source of page.items) {
        if (previous !== null && source.sourceReference <= previous) return fail();
        previous = source.sourceReference;
        if (json(source) !== json(expected.get(source.sourceReference)))
          return { complete: false, sourceCount: count };
        expected.delete(source.sourceReference);
        count++;
      }
      if (page.next === null) {
        if (!(await active())) return fail();
        return Object.freeze({ complete: expected.size === 0, sourceCount: count });
      }
      if (page.items.length !== 5 || page.next !== previous || pageNumber === 99) return fail();
      cursor = previous;
    }
    return fail();
  };
}
export function createInternalDiningCoverage({ resources, providerAccountReference }) {
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
  );
}
export function createInternalReconciliationCoverage(resources) {
  return createCoverage(
    resources,
    "PaymentReconciliationDifference",
    createInternalReconciliationExceptionPageRunner,
    "afterExceptionReference",
    "nextAfterExceptionReference",
    mapInternalReconciliationSource,
  );
}
