import { beforeEach, expect, it, vi } from "vitest";
import { finalValidationFixture } from "../../../packages/rms/inventory/src/tests/submission-final-validation.fixture.js";
import { createCustomerPaymentInventoryWorkflowSource } from "./customer-payment-inventory-workflow-source.js";
const mocks = vi.hoisted(() => ({ current: vi.fn(), publication: vi.fn(), runner: vi.fn() }));
vi.mock("@bop/workflow", async (original) => ({
  ...(await original<typeof import("@bop/workflow")>()),
  createPostgresWorkflowDefinitionStore: (runner: unknown) => {
    mocks.runner(runner);
    return { resolveCurrent: mocks.current, validatePublication: mocks.publication };
  },
}));
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const record = finalValidationFixture();
  const definition = {
    workflowReference: record.workflowReference,
    versionReference: record.workflowVersionReference,
    versionNumber: record.workflowVersion,
    transitions: [{ transitionReference: record.transitionReference }],
  };
  const current = { definition, brandDefinition: definition };
  mocks.current.mockResolvedValue(current);
  mocks.publication.mockResolvedValue(undefined);
  const tx = { query: vi.fn() };
  const authorizeOverride = vi.fn().mockResolvedValue(false);
  const source = createCustomerPaymentInventoryWorkflowSource(tx, record, {
    purposeCode: "Synthetic",
    applicabilityCode: "Pickup",
    authorizeOverride,
  });
  return { record, definition, current, tx, authorizeOverride, source };
}
it("uses Payment observation time and retains the caller transaction for current publication", async () => {
  const f = fixture();
  const at = "2026-09-11T10:01:00.000Z";
  const result = await f.source.resolve(f.record, at);
  expect(result.definition).toBe(f.definition);
  expect(mocks.current).toHaveBeenCalledWith({
    purposeCode: "Synthetic",
    applicabilityCode: "Pickup",
    observedAt: at,
  });
  expect(mocks.publication).toHaveBeenCalledWith(f.record.workflowVersionReference, at);
  const action = vi.fn().mockResolvedValue(true);
  await mocks.runner.mock.calls[0]?.[0].run(action);
  expect(action).toHaveBeenCalledWith(f.tx);
  expect(f.authorizeOverride).not.toHaveBeenCalled();
});
it.each(["version", "transition", "publication", "future", "scope"])(
  "rejects %s mismatch",
  async (kind) => {
    const f = fixture();
    let record = f.record;
    let at = f.record.observedAt;
    if (kind === "version") f.definition.versionNumber++;
    if (kind === "transition") f.definition.transitions = [];
    if (kind === "publication") mocks.publication.mockRejectedValue(new Error("synthetic revoked"));
    if (kind === "future") at = "2026-09-11T09:59:00.000Z";
    if (kind === "scope")
      record = { ...record, storeReference: "01909997-0000-7000-8000-000000000fff" };
    await expect(f.source.resolve(record, at)).rejects.toMatchObject({
      code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
    });
  },
);
it("requires explicit override authorization after both owner publications", async () => {
  const f = fixture();
  f.current.brandDefinition = {
    ...f.definition,
    versionReference: "01909997-0000-7000-8000-000000000ffe",
  };
  await expect(f.source.resolve(f.record, f.record.observedAt)).rejects.toThrow();
  expect(mocks.publication).toHaveBeenCalledTimes(2);
  expect(f.authorizeOverride).toHaveBeenCalledWith(f.tx, f.current);
  f.authorizeOverride.mockResolvedValue(true);
  await expect(f.source.resolve(f.record, f.record.observedAt)).resolves.toMatchObject({
    definition: f.definition,
  });
});
