import { describe, it, expect, vi } from "vitest";
import {
  createPostgresFeatureControlAdministrationQueryStore,
  type KillSwitchQueryTransaction,
  type FeatureControlAdministrationQueryAuthorization,
} from "../index.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const at = "2026-09-28T12:00:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const request = () => ({
  actorReference: id(3),
  purposeCode: "FEATURE_CONTROL_READ",
  key: "inventory.item.capability",
  observedAt: at,
});
const definition = () => ({
  controlId: id(4),
  key: request().key,
  description: "Synthetic item capability",
  version: 1,
  ownerReference: id(5),
  purposeCode: "ITEM_CAPABILITY",
  scope: { kind: "Brand", brandReference: id(1), storeReference: null },
  source: "BrandOverride",
  defaultValue: "Disabled",
  configuredValue: "Enabled",
  lifecycle: "Published",
  temporary: false,
  effectiveFrom: at,
  effectiveUntil: null,
  reviewAt: "2026-09-29T12:00:00.000Z",
  expiresAt: null,
  dependencies: [],
  authoredByReference: id(6),
  approvedByReference: id(7),
  approvalEvidenceReference: id(8),
  publicationReference: id(9),
});
const dep = () => ({
  dependencyId: id(10),
  kind: "RequiresFutureTrigger",
  targetKey: "inventory.item.readiness",
  minimumCompatibleVersion: 2,
  status: "Unsatisfied",
  evidenceReference: null,
  evidenceVersion: null,
});
const row = () => ({
  definition: definition(),
  recordedAt: at,
  dependencies: [{ storeReference: null, definition: dep() }],
});
function setup(rows: unknown = [row()]) {
  let held = false;
  const query = vi.fn(async () => {
    expect(held).toBe(true);
    return { rows };
  });
  const runCalls = vi.fn();
  const run = async <T>(work: (tx: KillSwitchQueryTransaction) => Promise<T>): Promise<T> => {
    runCalls();
    const value = await work({ query });
    expect(held).toBe(true);
    return value;
  };
  let allowed = true;
  const authorize = vi.fn();
  const authority: FeatureControlAdministrationQueryAuthorization = {
    async withAuthorizedDefinitionsScope(input, work) {
      authorize(input, work);
      if (!allowed) throw Error("private denial");
      held = true;
      try {
        return await work();
      } finally {
        held = false;
      }
    },
  };
  return {
    query,
    run: runCalls,
    authorize,
    denyAuthority: () => {
      allowed = false;
    },
    store: createPostgresFeatureControlAdministrationQueryStore({ run }, scope, authority),
  };
}
describe("authorized Feature Control administration history source", () => {
  it("preserves actual unsatisfied dependency, source and held authority without activation", async () => {
    const x = setup();
    const result = await x.store.load(request());
    expect(result.definitions[0]?.dependencies).toEqual([dep()]);
    expect(Object.isFrozen(result.definitions[0]?.dependencies[0])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.dependencyCoverage).toBe("Unconfirmed");
    expect(result).not.toHaveProperty("available");
    expect(result).not.toHaveProperty("backendExecution");
    expect(x.authorize).toHaveBeenCalledWith(
      { ...request(), ...scope, access: "AdministrationDefinitions" },
      expect.any(Function),
    );
  });
  it("returns empty history without enabling a default", async () => {
    expect((await setup([]).store.load(request())).definitions).toEqual([]);
  });
  it("preserves draft history", async () => {
    const raw = row();
    raw.definition = {
      ...raw.definition,
      lifecycle: "Draft",
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
    } as unknown as ReturnType<typeof definition>;
    expect((await setup([raw]).store.load(request())).definitions[0]?.lifecycle).toBe("Draft");
  });
  it("preserves expired history without evaluating effectiveness", async () => {
    const raw = row();
    raw.definition = {
      ...raw.definition,
      effectiveFrom: "2026-09-01T12:00:00.000Z",
      effectiveUntil: "2026-09-20T12:00:00.000Z",
      reviewAt: "2026-09-10T12:00:00.000Z",
      expiresAt: "2026-09-20T12:00:00.000Z",
      temporary: true,
    } as unknown as ReturnType<typeof definition>;
    expect((await setup([raw]).store.load(request())).definitions[0]?.expiresAt).toBe(
      "2026-09-20T12:00:00.000Z",
    );
  });
  it("rejects unavailable authority before any SQL", async () => {
    const x = setup();
    x.denyAuthority();
    await expect(x.store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
    expect(x.query).not.toHaveBeenCalled();
  });
  it("rejects phase registry identifier instead of silently translating key", async () => {
    const x = setup();
    await expect(
      x.store.load({ ...request(), key: "inventory.inv_item_list" }),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE" });
    expect(x.run).not.toHaveBeenCalled();
  });
  it("rejects foreign Brand", async () => {
    const raw = row();
    raw.definition.scope.brandReference = id(99);
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
  });
  it("rejects foreign Store", async () => {
    const raw = row();
    raw.definition.scope = {
      kind: "Store",
      brandReference: id(1),
      storeReference: id(99) as unknown as null,
    };
    raw.definition.source = "StoreOverride";
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
  });
  it("rejects visible child scope mismatch", async () => {
    const raw = row();
    raw.dependencies = [{ storeReference: id(2) as unknown as null, definition: dep() }];
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
  });
  it("rejects future recorded fact", async () => {
    const raw = row();
    raw.recordedAt = "2026-09-29T12:00:00.000Z";
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
  });
  it("rejects duplicate immutable version", async () => {
    await expect(setup([row(), row()]).store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
  });
  it("rejects version truncation sentinel", async () => {
    await expect(
      setup(Array.from({ length: 257 }, row)).store.load(request()),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE" });
  });
  it("rejects dependency truncation sentinel", async () => {
    const raw = row();
    raw.dependencies = Array.from({ length: 257 }, () => ({
      storeReference: null,
      definition: dep(),
    }));
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
  });
  it("rejects nested getter without invoking it", async () => {
    const raw = row(),
      getter = vi.fn(() => id(8));
    Object.defineProperty(raw.definition, "approvalEvidenceReference", {
      get: getter,
      enumerable: true,
    });
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects input getter before source access", async () => {
    const raw = request(),
      getter = vi.fn(() => id(3));
    Object.defineProperty(raw, "actorReference", { get: getter, enumerable: true });
    const x = setup();
    await expect(x.store.load(raw)).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(x.run).not.toHaveBeenCalled();
  });
  it("rejects sparse driver rows", async () => {
    await expect(setup(new Array(1)).store.load(request())).rejects.toMatchObject({
      code: "FEATURE_CONTROL_SOURCE_UNAVAILABLE",
    });
  });
});
