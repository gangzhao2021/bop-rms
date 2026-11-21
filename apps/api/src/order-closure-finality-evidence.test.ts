import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const d = vi.hoisted(() => ({ history: vi.fn(), finality: vi.fn(), store: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderClosureHistory: () => d.history,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresOrderSettledFinalityStore: d.store,
}));
import { createOrderClosureFinalityEvidence } from "./order-closure-finality-evidence.js";
const id = (n: number) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T01:00:00.000Z",
  old = "2026-09-21T00:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
beforeEach(() => {
  vi.resetAllMocks();
  d.store.mockReturnValue({ readFinality: d.finality });
});
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  const closure = {
    ...scope,
    closureReference: id(10),
    operationReference: id(11),
    orderReference: id(4),
    closureVersion: 1,
    orderVersion: 2,
    previousClosureReference: null,
    status: "Closed",
    actorType: "System",
    actorReference: null,
    reasonCode: "ORDER_COMPLETE",
    financialFinalityReference: id(6),
    evidenceDigest: digest,
    occurredAt: old,
  };
  const finality = {
    ...scope,
    orderReference: id(4),
    orderVersion: 2,
    orderCheckpoint: id(5),
    finalityReference: id(6),
    operationReference: id(8),
    providerAccountReference: id(7),
    environment: "Test",
    classification: "Settled",
    currencyCode: "CAD",
    pricedOrderTotalMinor: "100",
    capturedMinor: "120",
    capturedOrderAllocationMinor: "100",
    capturedTipMinor: "20",
    orderEvidenceDigest: digest,
    paymentEvidenceDigest: digest,
    decidedAt: old,
  };
  const history = {
    position: { ...scope, orderReference: id(4), observedAt: at, status: "Open", orderVersion: 3 },
    records: [closure],
  };
  d.history.mockResolvedValue(history);
  d.finality.mockResolvedValue(finality);
  const authorize = vi.fn(async () => true),
    tx = { query: vi.fn() } as ConsumerTransaction;
  const query = { orderReference: id(4), closureReference: id(10), observedAt: at };
  const read = createOrderClosureFinalityEvidence({
    scope,
    providerAccountReference: id(7),
    environment: "Test",
    authorize,
  });
  return { closure, finality, history, authorize, tx, query, run: () => read(tx, query) };
}
it("preserves exact historical closure and Payment fact even when current Order is open at a later version", async () => {
  const f = setup();
  expect(await f.run()).toEqual({ closure: f.closure, finality: f.finality });
  expect(d.finality).toHaveBeenCalledWith(f.tx, {
    orderReference: id(4),
    observedAt: at,
    finalityReference: id(6),
    expectedOrderVersion: 2,
  });
  expect(f.tx.query).not.toHaveBeenCalled();
  const options = d.store.mock.calls[0]?.[0];
  if (!options) throw Error("missing synthetic store options");
  await expect(options.audit()).rejects.toThrow();
});
it("returns no evidence for an absent or reopened closure rather than choosing another closure", async () => {
  const f = setup();
  f.query.closureReference = id(99);
  expect(await f.run()).toBeNull();
  f.query.closureReference = id(10);
  f.closure.status = "Open";
  expect(await f.run()).toBeNull();
  expect(d.finality).not.toHaveBeenCalled();
});
it("rejects missing or mismatched immutable Payment facts", async () => {
  for (const patch of [
    null,
    { storeReference: id(99) },
    { orderReference: id(99) },
    { orderVersion: 3 },
    { finalityReference: id(99) },
    { providerAccountReference: id(99) },
    { environment: "Live" },
    { decidedAt: at },
  ]) {
    const f = setup();
    d.finality.mockResolvedValue(patch === null ? null : { ...f.finality, ...patch });
    await expect(f.run()).rejects.toThrow("ORDER_CLOSURE_FINALITY_EVIDENCE_UNAVAILABLE");
  }
});
it("rejects changed history scope, future closure and duplicate matching identity", async () => {
  const f = setup();
  f.history.position.storeReference = id(99);
  await expect(f.run()).rejects.toThrow();
  f.history.position.storeReference = id(3);
  f.closure.occurredAt = "2026-09-22T00:00:00.000Z";
  await expect(f.run()).rejects.toThrow();
  f.closure.occurredAt = old;
  f.history.records.push(f.closure);
  await expect(f.run()).rejects.toThrow();
  expect(d.finality).not.toHaveBeenCalled();
});
it("denies before reads and after successful or empty reads when authority is revoked", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toThrow();
  expect(d.history).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toThrow();
  f.query.closureReference = id(99);
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toThrow();
});
