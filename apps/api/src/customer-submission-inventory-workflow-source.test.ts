import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalValidationFixture } from "../../../packages/rms/inventory/src/tests/submission-final-validation.fixture.js";
import { createCustomerSubmissionInventoryWorkflowSource } from "./customer-submission-inventory-workflow-source.js";
const mocks = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock("@bop/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/workflow")>()),
  createPostgresWorkflowDefinitionStore: () => ({ evaluatePublishedAction: mocks.evaluate }),
}));
function fixture(reserveNow = true) {
  const record = finalValidationFixture();
  const transition = {
    transitionReference: record.transitionReference,
    currentState: "CartReady",
    action: "SubmitOrder",
    nextState: "Submitted",
    permissionCode: "order.submit",
    ruleReferences: [],
    effects: reserveNow ? [{ ownerModule: "inventory", commandCode: "ReserveInventory" }] : [],
  };
  const later = {
    ...transition,
    transitionReference: "01909997-0000-7000-8000-000000000fff",
    currentState: "Submitted",
    action: "AcceptOrder",
    nextState: "Accepted",
    effects: [{ ownerModule: "inventory", commandCode: "ReserveInventory" }],
  };
  const definition = {
    workflowReference: record.workflowReference,
    versionReference: record.workflowVersionReference,
    versionNumber: record.workflowVersion,
    transitions: [transition, later],
  };
  mocks.evaluate.mockResolvedValue({ definition, transition });
  const scope = {
    tenantReference: record.tenantReference,
    brandReference: record.brandReference,
    storeReference: record.storeReference,
  };
  const request = {
    ...scope,
    actorReference: record.actorReference,
    resourceReference: record.cartReference,
    resourceVersion: record.cartVersion,
    purposeCode: "Synthetic",
    applicabilityCode: "Pickup",
    expectedVersionReference: record.workflowVersionReference,
    currentState: "CartReady",
    action: "SubmitOrder",
    observedAt: record.observedAt,
  };
  const gates = {
    authorizeResource: vi.fn(),
    authorizeAction: vi.fn(),
    authorizeOverride: vi.fn(),
    evaluateRule: vi.fn(),
  };
  const source = createCustomerSubmissionInventoryWorkflowSource({ query: vi.fn() }, scope, {
    reserveCommandCode: "ReserveInventory",
    gates,
  });
  return { record, request, source, definition, transition };
}
beforeEach(() => mocks.evaluate.mockReset());
describe("current published Workflow Inventory timing", () => {
  it("requires the actual published-action entry point for immediate reservation", async () => {
    const f = fixture();
    expect(await f.source.resolve(f.record, f.request)).toEqual(f.record);
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });
  it("rejects Reserved when the current transition has no reserve effect", async () => {
    const f = fixture(false);
    await expect(f.source.resolve(f.record, f.request)).rejects.toMatchObject({
      code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
    });
  });
  it("allows an explicitly pending reachable reserve action without granting Payment readiness", async () => {
    const f = fixture(false);
    const pending = {
      ...f.record,
      reservationSet: null,
      items: f.record.items.map((item) => ({
        ...item,
        disposition: "Deferred",
        deferredActionCode: "AcceptOrder",
      })),
    };
    expect((await f.source.resolve(pending, f.request)).items[0]?.disposition).toBe("Deferred");
    f.definition.transitions.pop();
    await expect(f.source.resolve(pending, f.request)).rejects.toMatchObject({
      code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
    });
  });
  it("rejects deferral of a reserve effect required now", async () => {
    const f = fixture();
    await expect(
      f.source.resolve(
        {
          ...f.record,
          reservationSet: null,
          items: f.record.items.map((item) => ({
            ...item,
            disposition: "Deferred",
            deferredActionCode: "AcceptOrder",
          })),
        },
        f.request,
      ),
    ).rejects.toMatchObject({ code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE" });
  });
  it("rejects a substituted resource before invoking Workflow", async () => {
    const f = fixture();
    await expect(
      f.source.resolve(f.record, { ...f.request, resourceVersion: 99 }),
    ).rejects.toMatchObject({ code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE" });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
