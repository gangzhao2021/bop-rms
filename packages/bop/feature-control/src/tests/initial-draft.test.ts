import { describe, expect, it, vi } from "vitest";
import { createPostgresFeatureControlInitialDraftStore } from "../index.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const at = "2026-09-28T12:00:00.000Z";
const input = () => ({
  definition: {
    controlId: id(4),
    key: "inventory.item.capability",
    description: "Synthetic capability Draft",
    version: 1,
    ownerReference: id(5),
    purposeCode: "ITEM_CAPABILITY",
    scope: { kind: "Store", brandReference: id(1), storeReference: id(2) },
    source: "StoreOverride",
    defaultValue: "Disabled",
    configuredValue: "Enabled",
    lifecycle: "Draft",
    temporary: false,
    effectiveFrom: at,
    effectiveUntil: null,
    reviewAt: "2026-09-29T12:00:00.000Z",
    expiresAt: null,
    dependencies: [
      {
        dependencyId: id(10),
        kind: "RequiresFutureTrigger",
        targetKey: "inventory.provider.readiness",
        minimumCompatibleVersion: 1,
        status: "Unsatisfied",
        evidenceReference: null,
        evidenceVersion: null,
      },
    ],
    authoredByReference: id(3),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
  },
  idempotencyKey: id(6),
  audit: {
    auditId: id(7),
    brandId: id(1),
    storeId: id(2),
    actor: { type: "User", reference: id(3) },
    actionCode: "FEATURE_CONTROL_SAVEDRAFT",
    targetType: "FeatureControl",
    targetId: id(4),
    reasonCode: "ITEM_CAPABILITY",
    correlationId: id(8),
    occurredAt: at,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "FEATURE_CONTROL_AUDIT",
    retentionPolicyVersion: 1,
  },
});
function setup() {
  const query = vi.fn(),
    runCalls = vi.fn();
  const run = async <T>(work: (tx: { query: typeof query }) => Promise<T>): Promise<T> => {
    runCalls();
    return work({ query });
  };
  const holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("synthetic missing authority");
  });
  const writer = createPostgresFeatureControlInitialDraftStore({
    brandReference: id(1),
    storeReference: id(2),
    actorReference: id(3),
    clock: { now: () => at },
    transactions: { run },
    authority: { holdUntilTransactionCompletes },
  });
  return { writer, run: runCalls, query, holdUntilTransactionCompletes };
}
describe("initial capability Draft authority and closed intent", () => {
  it.each([
    ["version", 2],
    ["lifecycle", "PendingApproval"],
    ["defaultValue", "Enabled"],
    ["authoredByReference", id(99)],
    ["publicationReference", id(99)],
    ["approvedByReference", id(99)],
    ["extra", true],
  ])("refuses %s before any transaction", async (field, value) => {
    const x = setup(),
      request = input();
    await expect(
      x.writer.createDraft({ ...request, definition: { ...request.definition, [field]: value } }),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_ADMIN_COMMIT_FAILED" });
    expect(x.run).not.toHaveBeenCalled();
    expect(x.query).not.toHaveBeenCalled();
  });
  it("refuses synthetic satisfied evidence before any SQL", async () => {
    const x = setup(),
      request = input();
    request.definition.dependencies[0] = {
      ...request.definition.dependencies[0],
      status: "Satisfied",
      evidenceReference: id(11),
      evidenceVersion: 1,
    } as never;
    await expect(x.writer.createDraft(request)).rejects.toMatchObject({
      code: "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
    });
    expect(x.run).not.toHaveBeenCalled();
  });
  it("refuses foreign Store and wrong Audit actor", async () => {
    for (const request of [
      {
        ...input(),
        definition: {
          ...input().definition,
          scope: { ...input().definition.scope, storeReference: id(99) },
        },
      },
      { ...input(), audit: { ...input().audit, actor: { type: "User", reference: id(99) } } },
    ]) {
      const x = setup();
      await expect(x.writer.createDraft(request)).rejects.toMatchObject({
        code: "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
      });
      expect(x.run).not.toHaveBeenCalled();
    }
  });
  it("does not invoke payload getters or accept injected context", async () => {
    const getter = vi.fn(() => input().definition);
    const x = setup();
    await expect(
      x.writer.createDraft({
        get definition() {
          return getter();
        },
        idempotencyKey: id(6),
        audit: input().audit,
      }),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_ADMIN_COMMIT_FAILED" });
    await expect(x.writer.createDraft({ ...input(), tenantContext: {} })).rejects.toMatchObject({
      code: "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(x.run).not.toHaveBeenCalled();
  });
  it("requires current change/scope/field authority even for a valid Draft", async () => {
    const x = setup();
    await expect(x.writer.createDraft(input())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_ADMIN_COMMIT_FAILED",
    });
    expect(x.holdUntilTransactionCompletes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: "CreateDraft",
        action: "feature.control.change",
        actorReference: id(3),
        brandReference: id(1),
        storeReference: id(2),
      }),
    );
    expect(x.query).not.toHaveBeenCalled();
  });
});
