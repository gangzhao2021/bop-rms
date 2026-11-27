import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ compensation: vi.fn(), dining: vi.fn(), reconciliation: vi.fn() }));
const r = vi.hoisted(() => ({ references: vi.fn() }));
vi.mock("./pilot-exception-references.mjs", () => ({
  readProjectedExceptionReferences: r.references,
}));
vi.mock("./pilot-compensation-coverage.mjs", () => ({
  readInternalCompensationCoverage: d.compensation,
}));
vi.mock("./pilot-owner-exception-coverage.mjs", () => ({
  createInternalDiningCoverage: () => d.dining,
  createInternalReconciliationCoverage: () => d.reconciliation,
}));
import { readInternalExceptionCoverage } from "./pilot-exception-coverage.mjs";
function options() {
  return {
    resources: {
      publicProfile: {
        binding: { tenantReference: "tenant", validUntil: "2026-09-22T00:00:00.000Z" },
      },
      scope: { brandReference: "brand", storeReference: "store" },
      now: () => "2026-09-21T00:00:00.000Z",
    },
    providerAccountReference: "account",
    paymentMode: "InternalTestOnlineCardAutomatic",
    tx: {},
    sources: [],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const mock of Object.values(d)) mock.mockResolvedValue({ complete: true, sourceCount: 0 });
  r.references.mockResolvedValue(new Map());
});
it("requires all three owners in the same transaction", async () => {
  const input = options();
  expect(await readInternalExceptionCoverage(input)).toBe("Fresh");
  for (const mock of Object.values(d)) expect(mock.mock.calls[0][0].tx).toBe(input.tx);
  // WP-2423: each owner check receives the projection's references from the same transaction.
  expect(r.references.mock.calls[0][0].tx).toBe(input.tx);
  for (const mock of Object.values(d))
    expect(mock.mock.calls[0][0].references).toBe(await r.references.mock.results[0].value);
});
it("does not claim coverage for a projected kind no owner check covers", async () => {
  r.references.mockResolvedValue(
    new Map([["x", { kind: "CaptureDeadlineExceeded", final: true }]]),
  );
  expect(await readInternalExceptionCoverage(options())).toBe("Stale");
  expect(d.compensation).not.toHaveBeenCalled();
});
it.each(["compensation", "dining", "reconciliation"])("keeps incomplete %s stale", async (kind) => {
  d[kind].mockResolvedValue({ complete: false });
  expect(await readInternalExceptionCoverage(options())).toBe("Stale");
});
it("does not claim terminal or unknown channel coverage", async () => {
  expect(await readInternalExceptionCoverage({ ...options(), paymentMode: "TerminalCard" })).toBe(
    "Stale",
  );
  expect(
    await readInternalExceptionCoverage({
      ...options(),
      sources: [{ kind: "CaptureDeadlineExceeded" }],
    }),
  ).toBe("Stale");
  expect(d.compensation).not.toHaveBeenCalled();
});
it("propagates owner failure without Fresh and rejects expiry", async () => {
  d.dining.mockRejectedValueOnce(Error("unavailable"));
  await expect(readInternalExceptionCoverage(options())).rejects.toThrow();
  const input = options();
  input.resources.now = () => "2026-09-23T00:00:00.000Z";
  expect(await readInternalExceptionCoverage(input)).toBe("Stale");
});
