import { expect, it } from "vitest";
import {
  parseOrderClosureRecord,
  resolveOrderClosureHistory,
} from "../domain/order-closure-record.js";
const id = (n: number) => "0190fad2-0000-7000-8000-" + String(n).padStart(12, "0");
const closed = {
  closureReference: id(1),
  operationReference: id(2),
  tenantReference: id(3),
  brandReference: id(4),
  storeReference: id(5),
  orderReference: id(6),
  closureVersion: 1,
  orderVersion: 4,
  previousClosureReference: null,
  status: "Closed",
  actorType: "System",
  actorReference: null,
  reasonCode: "ORDER_COMPLETE",
  financialFinalityReference: id(7),
  evidenceDigest: "sha256:" + "a".repeat(64),
  occurredAt: "2026-09-20T00:01:00.000Z",
};
const reopened = {
  ...closed,
  closureReference: id(8),
  operationReference: id(9),
  closureVersion: 2,
  previousClosureReference: id(1),
  status: "Open",
  actorType: "User",
  actorReference: id(10),
  reasonCode: "MANAGER_CORRECTION",
  financialFinalityReference: null,
  occurredAt: "2026-09-20T00:02:00.000Z",
};

it("preserves previous Close while reopening", () => {
  const result = resolveOrderClosureHistory([closed, reopened]);
  expect(result.status).toBe("Open");
  expect(result.previousClosureReference).toBe(closed.closureReference);
  expect(Object.isFrozen(result)).toBe(true);
});
it("permits later Close as a new immutable decision", () => {
  expect(
    resolveOrderClosureHistory([
      closed,
      reopened,
      {
        ...closed,
        closureReference: id(11),
        operationReference: id(12),
        closureVersion: 3,
        previousClosureReference: id(8),
        occurredAt: reopened.occurredAt,
      },
    ]).closureVersion,
  ).toBe(3);
});
it.each([
  { ...closed, financialFinalityReference: null },
  { ...reopened, actorType: "System", actorReference: null },
  { ...closed, previousClosureReference: id(40) },
  { ...closed, unexpected: true },
])("rejects malformed decision %#", (value) =>
  expect(() => parseOrderClosureRecord(value)).toThrow(),
);
it.each(
  [
    [],
    [reopened],
    [closed, { ...reopened, closureVersion: 3 }],
    [closed, { ...reopened, previousClosureReference: id(40) }],
    [closed, { ...closed, closureVersion: 2, previousClosureReference: id(1) }],
    [closed, { ...reopened, orderVersion: 3 }],
    [closed, { ...reopened, tenantReference: id(40) }],
    [closed, { ...reopened, occurredAt: "2026-09-19T00:00:00.000Z" }],
  ].map((values) => [values] as const),
)("rejects invalid full history %#", (values) =>
  expect(() => resolveOrderClosureHistory(values)).toThrow(),
);
