import { expect, it } from "vitest";
import { resolveOrderRevisionChain } from "../domain/order-revision-chain.js";
const id = (n: number) => "0190ed26-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T12:00:00.000Z";
function fixture() {
  const scope = { brandReference: id(1), storeReference: id(2), orderReference: id(3) };
  return {
    ...scope,
    initialSubmissionReference: id(4),
    createdAt: at,
    revisions: [
      {
        ...scope,
        revisionReference: id(5),
        previousRevisionReference: id(4),
        expectedVersion: 1,
        version: 2,
        occurredAt: at,
        kind: "AdditionalBatch",
      },
      {
        ...scope,
        revisionReference: id(6),
        previousRevisionReference: id(5),
        expectedVersion: 2,
        version: 3,
        occurredAt: at,
        kind: "Acceptance",
      },
    ],
  };
}
it("resolves one contiguous version sequence across additional submission and acceptance", () => {
  expect(resolveOrderRevisionChain(fixture())).toMatchObject({ version: 3, checkpoint: id(6) });
});
it("retains the original submission checkpoint before any later operation", () => {
  expect(resolveOrderRevisionChain({ ...fixture(), revisions: [] })).toMatchObject({
    version: 1,
    checkpoint: id(4),
  });
});
it.each([
  { expectedVersion: 1, version: 2 },
  { expectedVersion: 3, version: 4 },
  { previousRevisionReference: id(4) },
  { revisionReference: id(4) },
  { storeReference: id(90) },
  { occurredAt: "2026-09-13T11:59:59.000Z" },
  { expectedVersion: 2147483647, version: 2147483648 },
])("rejects branched, gapped or incompatible operation %j", (change) => {
  const f = fixture();
  const second = f.revisions[1];
  if (!second) throw new Error("fixture missing");
  f.revisions[1] = { ...second, ...change };
  expect(() => resolveOrderRevisionChain(f)).toThrow();
});
it("does not execute an accessor in history", () => {
  const f = fixture();
  let called = false;
  Object.defineProperty(f.revisions, "0", {
    get: () => {
      called = true;
      return null;
    },
    enumerable: true,
  });
  expect(() => resolveOrderRevisionChain(f)).toThrow();
  expect(called).toBe(false);
});

it("does not coerce an object kind while validating revision history", () => {
  const f = fixture();
  let called = false;
  const first = f.revisions[0];
  if (!first) throw new Error("fixture missing");
  const revisions = [
    {
      ...first,
      kind: {
        toString() {
          called = true;
          return "AdditionalBatch";
        },
      },
    },
  ];
  expect(() => resolveOrderRevisionChain({ ...f, revisions })).toThrow();
  expect(called).toBe(false);
});

it("includes a Batch cancellation without resetting other Order revision history", () => {
  const f = fixture();
  f.revisions.push({
    ...f.revisions[0],
    brandReference: f.brandReference,
    storeReference: f.storeReference,
    orderReference: f.orderReference,
    occurredAt: at,
    revisionReference: id(7),
    previousRevisionReference: id(6),
    expectedVersion: 3,
    version: 4,
    kind: "BatchCancellation",
  });
  expect(resolveOrderRevisionChain(f)).toMatchObject({ version: 4, checkpoint: id(7) });
});
