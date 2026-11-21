import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import { BrowserSessionError } from "@bop/identity";
import {
  BrandStoreTopologyError,
  brandStoreTopologyDraftRequiredFields,
  parseBrandStoreTopologySave,
  parseBrandStoreTopologyResolve,
  parseBrandStoreTopologyCurrent,
  parseBrandStoreTopologyDraftRevision,
  parseBrandStoreTopologyOperationReceipt,
  parseTenantStoreReferenceSnapshot,
  parseTenantStoreLabelReferenceSnapshot,
  type BrandStoreTopologyDraftStoreOptions,
} from "@bop/tenant";
import {
  createMerchantBrandStoreTopologyDraft,
  parseBrandStoreTopologyWorkbench,
} from "./merchant-brand-store-topology-draft.js";

const mocks = vi.hoisted(() => ({
  brand: vi.fn(),
  owner: vi.fn(),
  roster: vi.fn(),
  audit: vi.fn(),
  store: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.store }));
vi.mock("./merchant-brand-store-topology-capability.js", async (original) => ({
  ...(await original<typeof import("./merchant-brand-store-topology-capability.js")>()),
  createMerchantBrandStoreTopologyCapability: mocks.capability,
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.brand }));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresTransactionCurrentPermissionPolicySource: () => ({}),
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresBrandStoreTopologyDraftStore: mocks.owner,
  createPostgresTenantStoreReferenceSource: mocks.roster,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T14:00:00.000Z";
const until = new Date(Date.parse(at) + 5000).toISOString();
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const content = {
  profile: "BrandStoreTopologyDraftV1",
  tenantReference: id(1),
  brandReference: id(2),
  draftReference: id(6),
  selectors: [{ kind: "Region", reference: id(7), code: "NORTH", name: "North" }],
  assignments: [{ storeReference: id(4), selectorReference: id(7) }],
};
const save = () =>
  parseBrandStoreTopologySave({
    profile: "BrandStoreTopologySaveV1",
    ...scope,
    operationReference: id(8),
    expectedRevision: 0,
    content,
  });
const request = (command = save()) => ({
  sessionCookie: "synthetic",
  csrf: "synthetic",
  expectedScope: scope,
  command,
});
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const events: string[] = [];
  const state = {
    storeGuc: "",
    clock: at,
    allowed: true,
    deadline: until,
    labelsDrift: false,
    ownerFinal: true,
    lateDenied: false,
    clockExpired: false,
    shorten: false,
  };
  const decision = () => ({
    effect: state.allowed ? "Allow" : "Deny",
    reason: state.allowed ? "ROLE_PERMISSION" : "DEFAULT_DENY",
    source: state.allowed ? "RolePermission" : "DefaultDeny",
    action: "organization.manage",
    scopeKind: "Brand",
    policySnapshotReference: id(20),
    policyVersion: 1,
    audit: {
      effect: state.allowed ? "Allow" : "Deny",
      reason: state.allowed ? "ROLE_PERMISSION" : "DEFAULT_DENY",
      source: state.allowed ? "RolePermission" : "DefaultDeny",
    },
  });
  const batch = vi.fn(async (actions: readonly string[]) => {
    expect(actions).toEqual(["organization.manage"]);
    return { decisions: [decision()], validUntil: state.deadline };
  });
  const brand = {
    tenantReference: id(1),
    selectedStoreReference: id(4),
    context: { brand: { brandReference: id(2) } },
    actorReference: id(3),
    authorizeActionsWithValidity: batch,
  };
  mocks.brand.mockImplementation(async () => brand);
  const storeContext = { brand: brand.context.brand, resolvedAt: at };
  mocks.store.mockImplementation(async () => {
    state.storeGuc = id(4);
    return {
      selected: { tenantReference: id(1) },
      context: storeContext,
      actorReference: id(3),
      store: { storeReference: id(4) },
      allowed: async () => state.allowed,
      authorizationValidUntil: () => state.deadline,
    };
  });
  mocks.capability.mockImplementation(
    (
      o: Parameters<
        typeof import("./merchant-brand-store-topology-capability.js").createMerchantBrandStoreTopologyCapability
      >[0],
    ) => {
      let registered = false,
        checked = false,
        final = false;
      async function held() {
        const result = await o.holdCurrentBrandAuthority(o.transaction, {
          scope,
          selectedStoreReference: id(4),
          permission: "organization.manage",
          purposeCode: "STORE_CAPABILITY_EVALUATION",
          requiredFields: (await import("./merchant-brand-store-topology-capability.js"))
            .merchantBrandStoreTopologyCapabilityRequiredFields,
          observedAt: o.clock.now(),
          validUntil: state.deadline,
        });
        expect(result.permission.scopeKind).toBe("Brand");
        expect(result.tenantContext).toBe(storeContext);
      }
      return {
        async holdUntilCommit() {
          if (!registered) {
            registered = true;
            await o.registerBeforeCommit(
              o.transaction,
              async () => {
                await held();
                checked = true;
              },
              () => {
                if (!checked) throw new Error("controlled cap missing check");
                o.clock.now();
                final = true;
              },
            );
          }
          await held();
        },
        leaseDeadline: () => state.deadline,
        assertFinalized() {
          if (!final) throw new Error("controlled cap missing final");
          expect(events).toContain("commit");
        },
      };
    },
  );
  const entry = () => ({
    storeReference: id(4),
    lifecycle: "Suspended",
    version: "2",
    createdAt: at,
    updatedAt: at,
  });
  type SourceOptions = Parameters<
    typeof import("@bop/tenant").createPostgresTenantStoreReferenceSource
  >[0];
  mocks.roster.mockImplementation((o: SourceOptions) => {
    const held = async <T>(
      r: Parameters<typeof o.authority.withCurrentBrandReferenceRead>[0],
      work: () => Promise<T>,
    ) =>
      o.transactions.run(async (tx) => {
        expect(await o.authority.isCurrent(tx, r)).toBe(true);
        expect(state.storeGuc).toBe("");
        const result = await work();
        expect(await o.authority.isCurrent(tx, r)).toBe(true);
        expect(state.storeGuc).toBe("");
        return result;
      });
    return {
      async withCurrentSnapshot<T>(
        r: Parameters<typeof o.authority.withCurrentBrandReferenceRead>[0],
        work: (snapshot: ReturnType<typeof parseTenantStoreReferenceSnapshot>) => Promise<T>,
      ) {
        return o.authority.withCurrentBrandReferenceRead(r, () =>
          held(r, () =>
            work(
              parseTenantStoreReferenceSnapshot({
                profile: "TenantStoreReferenceV1",
                brandReference: id(2),
                brandLifecycle: "Active",
                brandVersion: "2",
                generation: "2",
                referenceCount: "1",
                originalIntentDigest: r.originalIntentDigest,
                observedAt: r.observedAt,
                references: [entry()],
              }),
            ),
          ),
        );
      },
      async withCurrentLabelSnapshot<T>(
        r: Parameters<typeof o.authority.withCurrentBrandReferenceRead>[0],
        work: (snapshot: ReturnType<typeof parseTenantStoreLabelReferenceSnapshot>) => Promise<T>,
      ) {
        events.push("labels");
        return o.authority.withCurrentBrandReferenceRead(r, () =>
          held(r, () =>
            work(
              parseTenantStoreLabelReferenceSnapshot({
                profile: "TenantStoreLabelReferenceV1",
                brandReference: id(2),
                brandLifecycle: "Active",
                brandVersion: "2",
                generation: "2",
                referenceCount: "1",
                originalIntentDigest: r.originalIntentDigest,
                observedAt: r.observedAt,
                references: [
                  {
                    ...entry(),
                    code: "STORE_NORTH",
                    displayName:
                      state.labelsDrift && events.filter((e) => e === "labels").length > 1
                        ? "Changed"
                        : "North Store",
                  },
                ],
              }),
            ),
          ),
        );
      },
    };
  });
  let captured: BrandStoreTopologyDraftStoreOptions | undefined;
  let snapshot: ReturnType<typeof parseBrandStoreTopologyDraftRevision> | null = null;
  let original: ReturnType<typeof parseBrandStoreTopologyOperationReceipt> | undefined;
  mocks.owner.mockImplementation((o: BrandStoreTopologyDraftStoreOptions) => {
    captured = o;
    let registered = false,
      done = false,
      final = false;
    let command: Parameters<typeof o.authority.holdUntilTransactionCompletes>[1]["command"] = null;
    let mode: "Read" | "Save" | "Resolve" = "Read";
    const hold = () =>
      o.authority.holdUntilTransactionCompletes(o.transaction, {
        ...scope,
        permission: "organization.manage",
        purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
        mode,
        requiredFields: brandStoreTopologyDraftRequiredFields,
        command,
        observedAt: o.clock.now(),
        validUntil: state.deadline,
      });
    async function enter() {
      if (done) throw new Error("controlled owner closed");
      if (!registered) {
        registered = true;
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            events.push("owner guard");
            if (state.lateDenied) state.allowed = false;
            if (state.clockExpired) state.clock = until;
            if (state.shorten) state.deadline = new Date(Date.parse(at) + 1000).toISOString();
            await hold();
            done = true;
          },
          () => {
            if (!done) throw new Error("controlled missing guard");
            o.clock.now();
            final = true;
          },
        );
      }
      await hold();
    }
    return {
      async readCurrent() {
        await enter();
        return parseBrandStoreTopologyCurrent(
          {
            profile: "BrandStoreTopologyCurrentV1",
            ...scope,
            current: snapshot,
            observedAt: o.clock.now(),
            validUntil: state.deadline,
          },
          o.clock.now(),
        );
      },
      async readHistory() {
        await enter();
        return snapshot ? [snapshot] : [];
      },
      async save(c: ReturnType<typeof parseBrandStoreTopologySave>) {
        mode = "Save";
        command = c;
        await enter();
        if (original) return original;
        await o.withCurrentStoreReferences(
          o.transaction,
          { ...scope, observedAt: at, validUntil: state.deadline },
          async (actual) => {
            expect(actual.references[0]?.storeReference).toBe(id(4));
          },
        );
        const auditReference = o.references.nextReference("Audit");
        const base = {
          profile: "BrandStoreTopologyDraftRevisionV1",
          ...scope,
          revision: 1,
          content: c.content,
          operationReference: c.operationReference,
          auditReference,
          createdAt: at,
          updatedAt: at,
          dataClassification: "ConfigurationMetadata",
        };
        snapshot = parseBrandStoreTopologyDraftRevision({ ...base, snapshotDigest: hash(base) });
        await o.appendAudit(o.transaction, {
          ...scope,
          auditReference,
          operationReference: c.operationReference,
          intentDigest: hash(c),
          purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
          mode: "Save",
          occurredAt: at,
        });
        original = parseBrandStoreTopologyOperationReceipt({
          profile: "BrandStoreTopologyOperationV1",
          ...scope,
          operationReference: c.operationReference,
          expectedRevision: 0,
          intentDigest: hash(c),
          outcome: "Committed",
          snapshot,
          auditReference,
          occurredAt: at,
          dataClassification: "ConfigurationMetadata",
        });
        return original;
      },
      async resolve(c: ReturnType<typeof parseBrandStoreTopologyResolve>) {
        mode = "Resolve";
        command = c;
        await enter();
        if (original) return original;
        const auditReference = o.references.nextReference("Audit");
        await o.appendAudit(o.transaction, {
          ...scope,
          auditReference,
          operationReference: c.operationReference,
          intentDigest: c.intentDigest,
          purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
          mode: "Abandon",
          occurredAt: at,
        });
        original = parseBrandStoreTopologyOperationReceipt({
          profile: "BrandStoreTopologyOperationV1",
          ...scope,
          operationReference: c.operationReference,
          expectedRevision: c.expectedRevision,
          intentDigest: c.intentDigest,
          outcome: "Abandoned",
          snapshot: null,
          auditReference,
          occurredAt: at,
          dataClassification: "ConfigurationMetadata",
        });
        return original;
      },
      assertFinalized(tx: unknown) {
        expect(tx).toBe(o.transaction);
        expect(events).toContain("commit");
        if (!final || !state.ownerFinal) throw new Error("controlled missing final");
        return state.deadline;
      },
    };
  });
  mocks.audit.mockImplementation(async (_tx, record) => {
    // The actual Brand-level Audit RLS refuses a selected Store context.
    expect(state.storeGuc).toBe("");
    validateAuditRecord(record, Date.parse(state.clock));
    events.push("audit");
    return { auditId: record.auditId };
  });
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql === "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)") {
      expect(values).toEqual([id(2)]);
      state.storeGuc = "";
      events.push("restore Brand RLS");
    }
    return { rows: [], rowCount: 1 };
  });
  const run = async <T>(work: (tx: { query: typeof query }) => Promise<T>) => {
    events.push("begin");
    try {
      const result = await work({ query });
      events.push("commit");
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    }
  };
  const authenticate = vi.fn(async () => ({ sessionReference: id(5) }));
  let n = 40;
  const options = {
    persistence: {
      now: () => state.clock,
      transactions: { run },
      identity: { hasher: {} },
      currentActor: async () => undefined,
      validateAssociation: async () => true,
    },
    authentication: { authorize: authenticate },
    nextReference: () => id(n++),
  };
  // Controlled public composition ports: these are not encrypted Session/IAM/native PG evidence.
  const service = createMerchantBrandStoreTopologyDraft(
    options as unknown as Parameters<typeof createMerchantBrandStoreTopologyDraft>[0],
  );
  return {
    service,
    state,
    events,
    options,
    authenticate,
    brand,
    batch,
    captured: () => captured,
    original: () => original,
  };
}
it("returns actual labels, full immutable history and DraftOnly current after COMMIT", async () => {
  const f = fixture();
  const value = await f.service.workspace({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedBrandReference: id(2),
  });
  expect(value.current.current).toBeNull();
  expect(value.stores.references[0]).toMatchObject({
    code: "STORE_NORTH",
    displayName: "North Store",
    lifecycle: "Suspended",
  });
  expect(value.status).toBe("DraftOnly");
  expect(f.events).toContain("commit");
  expect(f.events.filter((e) => e === "labels")).toHaveLength(2);
  expect(f.events).not.toContain("audit");
});
it("saves actual owning command with complete roster and digest-only Audit", async () => {
  const f = fixture();
  const receipt = await f.service.save(request());
  expect(receipt.outcome).toBe("Committed");
  expect(receipt.snapshot?.content).toEqual(content);
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  expect(mocks.audit.mock.calls[0]?.[1].afterSummary).toEqual({ intentDigest: hash(save()) });
  expect(f.captured()?.transaction).toBeDefined();
});
it("resolves absent original only after actual Audit and host COMMIT", async () => {
  const f = fixture();
  const command = parseBrandStoreTopologyResolve({
    profile: "BrandStoreTopologyResolveV1",
    ...scope,
    operationReference: id(8),
    expectedRevision: 0,
    intentDigest: hash(save()),
  });
  const receipt = await f.service.resolve({ ...request(), command });
  expect(receipt.outcome).toBe("Abandoned");
  expect(receipt.snapshot).toBeNull();
  expect(f.events).toContain("commit");
  expect(f.events).not.toContain("labels");
});
it.each(["tenantReference", "brandReference", "actorReference"])(
  "rejects changed %s before owner or reference allocation",
  async (key) => {
    const f = fixture();
    await expect(
      f.service.save({ ...request(), expectedScope: { ...scope, [key]: id(90) } }),
    ).rejects.toMatchObject({ code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED" });
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  },
);
it("refuses a route Brand different from actual selected Brand", async () => {
  const f = fixture();
  await expect(
    f.service.workspace({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedBrandReference: id(90),
    }),
  ).rejects.toMatchObject({ code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED" });
  expect(mocks.owner).not.toHaveBeenCalled();
});
it("requires actual CSRF authorization before transaction", async () => {
  const f = fixture();
  f.authenticate.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  await expect(f.service.save(request())).rejects.toMatchObject({
    code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED",
  });
  expect(f.events).not.toContain("begin");
});
it("current organization permission withdrawal rolls back original writes", async () => {
  const f = fixture();
  f.state.lateDenied = true;
  await expect(f.service.save(request())).rejects.toMatchObject({
    code: "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED",
  });
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("captured authentication port changes fail closed", async () => {
  const f = fixture();
  f.options.authentication.authorize = vi.fn(async () => ({ sessionReference: id(5) }));
  await expect(f.service.save(request())).rejects.toMatchObject({
    code: "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).not.toContain("begin");
});
it("late label changes invalidate workspace before COMMIT", async () => {
  const f = fixture();
  f.state.labelsDrift = true;
  await expect(
    f.service.workspace({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedBrandReference: id(2),
    }),
  ).rejects.toMatchObject({ code: "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT" });
  expect(f.events).not.toContain("commit");
});
it("natural five-second expiry rejects held original", async () => {
  const f = fixture();
  f.state.clockExpired = true;
  await expect(f.service.save(request())).rejects.toMatchObject({
    code: "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).not.toContain("commit");
});
it("actual final shorter lease is returned in workspace", async () => {
  const f = fixture();
  f.state.shorten = true;
  const value = await f.service.workspace({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedBrandReference: id(2),
  });
  expect(value.validUntil).toBe(new Date(Date.parse(at) + 1000).toISOString());
  expect(value.current.validUntil).toBe(value.validUntil);
});
it("missing owning final assertion refuses a success receipt", async () => {
  const f = fixture();
  f.state.ownerFinal = false;
  await expect(f.service.save(request())).rejects.toMatchObject({
    code: "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE",
  });
});
it("closed input rejects authority injection without dispatch", async () => {
  const f = fixture();
  await expect(
    f.service.save({ ...request(), enabled: true } as unknown as Parameters<
      typeof f.service.save
    >[0]),
  ).rejects.toMatchObject({ code: "BRAND_STORE_TOPOLOGY_INPUT_INVALID" });
  expect(f.events).not.toContain("begin");
});
it("unknown authority failure remains bounded unavailable", async () => {
  const f = fixture();
  f.batch.mockRejectedValueOnce(new Error("controlled unavailable"));
  await expect(f.service.save(request())).rejects.toMatchObject({
    code: "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE",
  });
});

it("replays the exact original without allocating another Audit or requalifying roster", async () => {
  const f = fixture();
  const first = await f.service.save(request());
  const again = await f.service.save(request());
  expect(again).toEqual(first);
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  const resolve = parseBrandStoreTopologyResolve({
    profile: "BrandStoreTopologyResolveV1",
    ...scope,
    operationReference: id(8),
    expectedRevision: 0,
    intentDigest: hash(save()),
  });
  expect(await f.service.resolve({ ...request(), command: resolve })).toEqual(first);
  expect(mocks.audit).toHaveBeenCalledTimes(1);
});
it("the Workbench parser rejects forged history/latest joins and expired transport", async () => {
  const f = fixture();
  await f.service.save(request());
  const value = await f.service.workspace({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedBrandReference: id(2),
  });
  expect(value.history).toHaveLength(1);
  expect(parseBrandStoreTopologyWorkbench(value, at)).toEqual(value);
  expect(() => parseBrandStoreTopologyWorkbench({ ...value, history: [] }, at)).toThrow(
    BrandStoreTopologyError,
  );
  expect(() =>
    parseBrandStoreTopologyWorkbench(
      { ...value, history: [value.history[0], value.history[0]] },
      at,
    ),
  ).toThrow(BrandStoreTopologyError);
  expect(() => parseBrandStoreTopologyWorkbench(value, until)).toThrow(BrandStoreTopologyError);
});
it("outbound history getters are refused without executing them", async () => {
  const f = fixture();
  const value = await f.service.workspace({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedBrandReference: id(2),
  });
  const getter = vi.fn(),
    history: unknown[] = [];
  Object.defineProperty(history, "0", { enumerable: true, get: getter });
  expect(() => parseBrandStoreTopologyWorkbench({ ...value, history }, at)).toThrow(
    BrandStoreTopologyError,
  );
  expect(getter).not.toHaveBeenCalled();
});
it("restores Brand RLS after genuine Store admission before complete labels and final heads", async () => {
  const f = fixture();
  const value = await f.service.workspace({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedBrandReference: id(2),
  });
  expect(value.stores.referenceCount).toBe("1");
  expect(mocks.store).toHaveBeenCalled();
  expect(f.events.filter((event) => event === "restore Brand RLS").length).toBeGreaterThanOrEqual(
    4,
  );
  expect(f.events).toContain("commit");
});

it("restores actual Brand scope for immutable Audit after Store Feature authorization", async () => {
  const f = fixture();
  const receipt = await f.service.save(request());
  expect(receipt.outcome).toBe("Committed");
  const auditIndex = f.events.indexOf("audit");
  expect(auditIndex).toBeGreaterThan(0);
  expect(f.events[auditIndex - 1]).toBe("restore Brand RLS");
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  expect(f.events).toContain("commit");
});
