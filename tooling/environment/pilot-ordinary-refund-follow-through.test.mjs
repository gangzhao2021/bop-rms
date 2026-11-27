import { expect, test } from "vitest";
import { createFollowThroughWorkforceContext } from "./pilot-ordinary-refund-follow-through.mjs";

const id = (n) => "0190fa46-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const query = (patch = {}) => ({
  ...scope,
  actorReference: id(9),
  observedAt: "2026-11-10T12:00:00.000Z",
  permissionCode: "payment.refund.execute",
  ...patch,
});
const tx = (ok) => ({
  query: async (sql) =>
    sql.includes("clock_timestamp") ? { rows: [{ ok }], rowCount: 1 } : { rows: [], rowCount: 0 },
});

test("WP-2423 M16: the system's follow-through answers only refund facts of its own Store, never after the binding ends or ahead of the database clock", async () => {
  const context = createFollowThroughWorkforceContext({
    scope,
    now: () => "2026-11-10T12:00:01.000Z",
    validUntil: () => "2026-11-20T00:00:00.000Z",
  });
  for (const refused of [
    query({ storeReference: id(4) }),
    query({ brandReference: id(5) }),
    query({ permissionCode: "ordering.order.cancel" }),
    query({ permissionCode: "payment.refund.recover" }),
  ])
    await expect(context(tx(true), refused)).rejects.toThrow(
      "INTERNAL_REFUND_FOLLOW_THROUGH_DENIED",
    );
  // An instant after the database's now is refused.
  await expect(context(tx(false), query())).rejects.toThrow(
    "INTERNAL_REFUND_FOLLOW_THROUGH_DENIED",
  );
  // Past the installation's binding nothing is answered.
  const ended = createFollowThroughWorkforceContext({
    scope,
    now: () => "2026-11-21T00:00:00.000Z",
    validUntil: () => "2026-11-20T00:00:00.000Z",
  });
  await expect(ended(tx(true), query())).rejects.toThrow("INTERNAL_REFUND_FOLLOW_THROUGH_DENIED");
});
