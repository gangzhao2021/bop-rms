import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolveCurrent: vi.fn(),
  validatePublication: vi.fn(),
  compose: vi.fn(() => ({ cancel: vi.fn() })),
}));
vi.mock("../../packages/bop/workflow/src/index.ts", () => ({
  createPostgresWorkflowDefinitionStore: () => ({
    resolveCurrent: mocks.resolveCurrent,
    validatePublication: mocks.validatePublication,
  }),
}));
vi.mock("../../apps/api/dist/dining-batch-cancellation-inventory.js", () => ({
  createDiningBatchCancellationInventory: () => ({}),
}));
vi.mock("../../apps/api/dist/dining-batch-cancellation.js", () => ({
  createDiningBatchCancellation: mocks.compose,
}));
import { createInternalBatchCancellation } from "./pilot-batch-cancellation.mjs";
const scope = { tenantReference: "tenant", brandReference: "brand", storeReference: "store" };
const definition = {
  purposeCode: "InternalTestBatchCancellation",
  workflowReference: "workflow",
  transitions: [],
};
const saved = { environment: "InternalTest", database: "synthetic", scope, definition };
const resources = {
  scope: { brandReference: "brand", storeReference: "store" },
  publicProfile: { binding: { tenantReference: "tenant", validUntil: "2026-10-01T00:00:00.000Z" } },
  now: () => "2026-09-21T12:00:00.000Z",
  credentials: { reference: vi.fn() },
  transactions: {},
};
const options = () => ({
  loadWorkflow: async () => saved,
  expectedDatabaseName: "synthetic",
  systemActorReference: "actor",
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("rejects mismatched configuration before constructing cancellation", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await expect(
    createInternalBatchCancellation(resources, { ...options(), expectedDatabaseName: "other" }),
  ).rejects.toThrow("INTERNAL_BATCH_CANCELLATION_UNAVAILABLE");
  expect(mocks.compose).not.toHaveBeenCalled();
});
it("requires currently published matching workflow and validates publication before returning it", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const service = await createInternalBatchCancellation(resources, options());
  mocks.resolveCurrent.mockResolvedValue({
    definition: {
      ...definition,
      lifecycle: "Draft",
      storeReference: null,
      versionReference: "version",
    },
  });
  await expect(service.loadPublished({}, resources.now())).rejects.toThrow(
    "INTERNAL_BATCH_CANCELLATION_UNAVAILABLE",
  );
  expect(mocks.validatePublication).not.toHaveBeenCalled();
  const published = {
    ...definition,
    lifecycle: "Published",
    storeReference: null,
    versionReference: "version",
  };
  mocks.resolveCurrent.mockResolvedValue({ definition: published });
  expect(await service.loadPublished({}, resources.now())).toBe(published);
  expect(mocks.validatePublication).toHaveBeenCalledWith("version", resources.now());
  mocks.resolveCurrent.mockResolvedValue({
    definition: { ...published, transitions: [{ unexpected: true }] },
  });
  await expect(service.loadPublished({}, resources.now())).rejects.toThrow(
    "INTERNAL_BATCH_CANCELLATION_UNAVAILABLE",
  );
});
