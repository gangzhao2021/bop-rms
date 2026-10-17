import {
  createPostgresPaymentCompensationExceptionCandidates,
  createPostgresPaymentCompensationExceptionSource,
} from "../../packages/rms/payment/src/index.ts";
import { parseOrderExceptionSource } from "../../packages/bop/projection/src/index.ts";
import { mapInternalCompensationSource } from "./pilot-compensation-projection.mjs";
import { COVERAGE_PAGE_LIMIT, projectedReferences } from "./pilot-exception-references.mjs";
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
/**
 * Compensation coverage only; caller keeps this transaction and its whole-workbench snapshot.
 * WP-2423: `projected` is what the page shows (every open case and one page of resolved ones) and
 * `references` every case the projection holds (reference, kind, final). Every owner case must be
 * projected; each shown case must equal its owner's current state; a projected final case not
 * shown is not re-read (Final is terminal and was checked against the owner when written), so the
 * owner reads grow with the open cases, not with the Store's lifetime count.
 */
export async function readInternalCompensationCoverage({
  tx,
  scope,
  tenantReference,
  projected,
  references,
  authorize,
}) {
  const fail = () => {
    throw Error("INTERNAL_COMPENSATION_COVERAGE_UNAVAILABLE");
  };
  if (!(await authorize(tx))) return fail();
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
    if (
      source.tenantReference !== tenantReference ||
      source.brandReference !== scope.brandReference ||
      source.storeReference !== scope.storeReference
    )
      return fail();
    if (source.kind !== "PaidWithoutFulfillableOrder") continue;
    if (expected.has(source.sourceReference)) return fail();
    expected.set(source.sourceReference, source);
  }
  const known = projectedReferences("PaidWithoutFulfillableOrder", references, expected, fail);
  const permitted = async (t, input) =>
    t === tx &&
    input.brandReference === scope.brandReference &&
    input.storeReference === scope.storeReference &&
    (await authorize(tx));
  const discover = createPostgresPaymentCompensationExceptionCandidates({
      scope,
      authorize: permitted,
    }),
    read = createPostgresPaymentCompensationExceptionSource({ scope, authorize: permitted });
  let cursor = null,
    count = 0;
  const seen = new Set();
  for (let pageNumber = 0; pageNumber < COVERAGE_PAGE_LIMIT; pageNumber++) {
    const page = await discover(tx, { afterCaseReference: cursor, limit: 100 });
    if (!Array.isArray(page.items) || page.items.length > 100) return fail();
    let last = cursor;
    for (const reference of page.items) {
      if (typeof reference !== "string" || (last !== null && reference <= last)) return fail();
      last = reference;
      if (!known.has(reference)) return { complete: false, sourceCount: count };
      seen.add(reference);
      count++;
      if (!expected.has(reference)) {
        // Not shown: only a final case may be left unread; a projected open case is always shown.
        if (known.get(reference) !== true) return { complete: false, sourceCount: count };
        continue;
      }
      const current = await read(tx, reference);
      if (!current) return fail();
      const source = mapInternalCompensationSource({
        current,
        caseReference: reference,
        scope,
        tenantReference,
        disposition: {
          orderReference: current.source.orderReference,
          paymentIntentReference: current.source.paymentIntentReference,
          paymentAttemptReference: current.source.paymentAttemptReference,
        },
      });
      if (json(source) !== json(expected.get(reference)))
        return { complete: false, sourceCount: count };
    }
    if (page.nextAfterCaseReference === null) {
      if (!(await authorize(tx))) return fail();
      return Object.freeze({
        complete: [...known.keys()].every((reference) => seen.has(reference)),
        sourceCount: count,
      });
    }
    if (page.items.length !== 100 || page.nextAfterCaseReference !== last) return fail();
    cursor = last;
  }
  return fail();
}
