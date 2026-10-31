import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ runner: vi.fn(), store: vi.fn(), write: vi.fn() }));
vi.mock("./pilot-dining-exception-episodes.mjs", () => ({
  createInternalDiningExceptionEpisodePageRunner: d.runner,
}));
vi.mock("../../packages/bop/projection/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresOrderExceptionSourceStore: d.store,
}));
import { createInternalDiningProjection } from "./pilot-dining-projection.mjs";
const id = (n) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z";
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    tx = {};
  const source = {
    ...scope,
    sourceReference: id(10),
    orderReference: id(4),
    paymentReference: null,
    diningReference: id(5),
    kind: "DiningUnpaidBatch",
    severity: "Critical",
    sourceOwner: "Dining",
    sourceStatus: "Open",
    providerState: "NotApplicable",
    compensationStatus: "NotRequested",
    sourceVersion: 1n,
    sourceDigest: "sha256:" + "a".repeat(64),
    createdAt: at,
    updatedAt: at,
    resolutionEvidenceReference: null,
  };
  const page = { items: [{ source }], nextAfterTaskReference: null };
  const context = {
    tx,
    scope,
    page,
    authorize: () => true,
    rereadSource: vi.fn(
      async (reference) => page.items.find((v) => v.source.sourceReference === reference)?.source,
    ),
  };
  const inputs = [];
  d.runner.mockImplementation((_options, consume) => async (input) => {
    inputs.push(input);
    return consume(context);
  });
  return {
    source,
    page,
    context,
    inputs,
    recover: createInternalDiningProjection({
      resources: { credentials: { reference: () => id(90) } },
      providerAccountReference: id(6),
    }),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.store.mockImplementation((options) => ({
    write: async (tx, source, checkpoint) => {
      if (!(await options.authorize(tx)) || !(await options.validateSource(tx, source)))
        throw Error("source changed");
      return d.write(tx, source, checkpoint);
    },
  }));
});
it("writes Open and Final owner facts with fresh source validation", async () => {
  const f = setup();
  expect(await f.recover()).toEqual({ projectedCount: 1, scanComplete: true });
  expect(d.write.mock.calls[0][1]).toMatchObject({ sourceStatus: "Open", sourceVersion: 1n });
  f.source.sourceStatus = "Final";
  f.source.sourceVersion = 2n;
  f.source.resolutionEvidenceReference = id(20);
  await f.recover();
  expect(d.write.mock.calls[1][1]).toMatchObject({ sourceStatus: "Final", sourceVersion: 2n });
  expect(f.context.rereadSource).toHaveBeenCalledTimes(2);
});
it("keeps cursor on failed page and resets only after complete scan", async () => {
  const f = setup();
  f.page.items = [10, 11, 12, 13, 14].map((n) => ({
    source: { ...f.source, sourceReference: id(n) },
  }));
  f.page.nextAfterTaskReference = id(14);
  d.write.mockRejectedValueOnce(Error("failed"));
  await expect(f.recover()).rejects.toThrow();
  await f.recover();
  expect(f.inputs.slice(0, 2)).toEqual([
    { afterTaskReference: null, limit: 5 },
    { afterTaskReference: null, limit: 5 },
  ]);
  f.page.items = [];
  f.page.nextAfterTaskReference = null;
  await f.recover();
  await f.recover();
  expect(f.inputs.slice(2)).toEqual([
    { afterTaskReference: id(14), limit: 5 },
    { afterTaskReference: null, limit: 5 },
  ]);
});
it("refuses changed source, wrong scope, revoked authority and nonprogressing pages", async () => {
  const f = setup();
  f.context.rereadSource.mockResolvedValueOnce({
    ...f.source,
    sourceDigest: "sha256:" + "b".repeat(64),
  });
  await expect(f.recover()).rejects.toThrow();
  expect(d.write).not.toHaveBeenCalled();
  f.context.authorize = () => false;
  await expect(f.recover()).rejects.toThrow();
  f.context.authorize = () => true;
  f.source.storeReference = id(99);
  await expect(f.recover()).rejects.toThrow();
  f.source.storeReference = id(3);
  f.page.nextAfterTaskReference = id(10);
  await expect(f.recover()).rejects.toThrow();
});
