import { beforeEach, expect, it, vi } from "vitest";
import { BrowserSessionError } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import {
  parseStoreSetupReferenceVersion,
  parseStoreSetupReferenceReceipt,
  parseStoreSetupReferencesCurrent,
  storeSetupReferenceOperationRequiredFields,
  type StoreSetupReferenceStoreOptions,
  type StoreSetupReferenceSave,
  type StoreSetupReferenceResolve,
  type StoreSetupReferenceKind,
} from "@rms/store";
import { createMerchantStoreSetupReferences } from "./merchant-store-setup-references.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), owner: vi.fn(), audit: vi.fn(), base: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPostgresStoreSetupReferenceStore: mocks.owner,
  createPostgresStoreConfigurationAuthoringSource: () => mocks.base,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
const id = (n: number) => `018f9f40-0010-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T14:00:00.000Z",
  until = new Date(Date.parse(at) + 5000).toISOString();
const scope4 = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const address = {
  countryCode: "CA",
  regionCode: "ON",
  locality: "Synthetic locality",
  postalCode: "A1A 1A1",
  addressLines: ["1 Synthetic Way"],
};
const contact = {
  contactName: "Synthetic Store contact",
  businessPhone: "+14165550100",
  website: "https://example.invalid/",
};
const body = (kind: StoreSetupReferenceKind = "Address") => ({
  command: "SaveReference",
  operationReference: id(8),
  expectedReference: null,
  expectedRevision: 0,
  content: kind === "Address" ? address : contact,
});
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const events: string[] = [];
  const state = {
    clock: at,
    allowed: true,
    until,
    dropFinal: false,
    shorten: false,
    expire: false,
    auditFailure: false,
    wrongKind: false,
    historical: false,
  };
  const allowed = vi.fn(async () => state.allowed);
  const scope = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    actorReference: id(4),
    sessionReference: id(5),
    store: { storeReference: id(3) },
    allowed,
    authorizationValidUntil: () => state.until,
  };
  mocks.scope.mockImplementation(async (_tx, _cookie, action, expectedSession) => {
    events.push("scope");
    expect(action).toBe("organization.manage");
    if (expectedSession !== undefined) expect(expectedSession).toBe(id(5));
    return scope;
  });
  mocks.base.mockImplementation(() => {
    throw new Error("Complete base must not be acquired");
  });
  mocks.audit.mockImplementation(async (_tx, input) => {
    validateAuditRecord(input, Date.parse(state.clock));
    events.push("audit");
    if (state.auditFailure) throw new Error("Synthetic audit failure");
  });
  const handles: { owner?: StoreSetupReferenceStoreOptions } = {};
  mocks.owner.mockImplementation((o: StoreSetupReferenceStoreOptions) => {
    handles.owner = o;
    let active = false,
      guarded = false,
      finalized = false,
      registered = false,
      deadline = o.originalValidUntil;
    let command: StoreSetupReferenceSave | StoreSetupReferenceResolve | null = null;
    let mode: "ReadAll" | "Save" | "Resolve" = "ReadAll";
    const hold = async () => {
      const result = await o.authority.holdUntilTransactionCompletes(o.transaction, {
        ...scope4,
        permission: "organization.manage",
        purposeCode: "STORE_SETUP_REFERENCE",
        mode,
        kind: state.wrongKind ? "Contact" : (command?.kind ?? null),
        requiredFields: storeSetupReferenceOperationRequiredFields,
        command,
        observedAt: o.clock.now(),
        validUntil: deadline,
      });
      if (result.validUntil < deadline) deadline = result.validUntil;
    };
    const enter = async () => {
      if (active || guarded) throw new Error("Owning phase closed");
      active = true;
      if (!registered) {
        registered = true;
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            if (active || guarded) throw new Error("Invalid owning guard");
            events.push("owner guard");
            if (state.shorten) state.until = new Date(Date.parse(at) + 1000).toISOString();
            if (state.expire) state.clock = until;
            await hold();
            guarded = true;
          },
          () => {
            events.push("owner final");
            if (!guarded) throw new Error("Missing guard");
            o.clock.now();
            finalized = true;
          },
        );
      }
      await hold();
    };
    return {
      async readCurrent() {
        await enter();
        active = false;
        const historical = state.historical
          ? parseStoreSetupReferenceVersion({
              profile: "StoreSetupReferenceVersionV1",
              tenantReference: id(1),
              brandReference: id(2),
              storeReference: id(3),
              kind: "Address",
              reference: id(90),
              revision: 1,
              authoredByReference: id(88),
              previousReference: null,
              content: address,
              createdAt: at,
              updatedAt: at,
              dataClassification: "Internal",
            })
          : null;
        return parseStoreSetupReferencesCurrent({
          profile: "StoreSetupReferencesCurrentV1",
          ...scope4,
          address: historical,
          contact: null,
          observedAt: at,
          validUntil: deadline,
          businessReferenceValidation: "NotEvaluated",
        });
      },
      async save(c: StoreSetupReferenceSave) {
        command = c;
        mode = "Save";
        await enter();
        const snapshot = parseStoreSetupReferenceVersion({
          profile: "StoreSetupReferenceVersionV1",
          tenantReference: o.tenantReference,
          brandReference: o.brandReference,
          storeReference: o.storeReference,
          kind: c.kind,
          reference: o.references.nextReference("Reference"),
          revision: 1,
          authoredByReference: o.actorReference,
          previousReference: null,
          content: c.content,
          createdAt: at,
          updatedAt: at,
          dataClassification: "Internal",
        });
        const auditReference = o.references.nextReference("Audit"),
          intentDigest = hash(c);
        await o.appendAudit(o.transaction, {
          ...scope4,
          kind: c.kind,
          operationReference: c.operationReference,
          auditReference,
          intentDigest,
          purposeCode: "STORE_SETUP_REFERENCE",
          mode: "Save",
          occurredAt: at,
        });
        active = false;
        return parseStoreSetupReferenceReceipt({
          profile: "StoreSetupReferenceReceiptV1",
          ...scope4,
          kind: c.kind,
          operationReference: c.operationReference,
          expectedReference: c.expectedReference,
          expectedRevision: c.expectedRevision,
          intentDigest,
          outcome: "Committed",
          snapshot,
          auditReference,
          occurredAt: at,
        });
      },
      async resolve(c: StoreSetupReferenceResolve) {
        command = c;
        mode = "Resolve";
        await enter();
        const auditReference = o.references.nextReference("Audit");
        await o.appendAudit(o.transaction, {
          ...scope4,
          kind: c.kind,
          operationReference: c.operationReference,
          auditReference,
          intentDigest: c.intentDigest,
          purposeCode: "STORE_SETUP_REFERENCE",
          mode: "Abandon",
          occurredAt: at,
        });
        active = false;
        return parseStoreSetupReferenceReceipt({
          profile: "StoreSetupReferenceReceiptV1",
          ...scope4,
          kind: c.kind,
          operationReference: c.operationReference,
          expectedReference: c.expectedReference,
          expectedRevision: c.expectedRevision,
          intentDigest: c.intentDigest,
          outcome: "Abandoned",
          snapshot: null,
          auditReference,
          occurredAt: at,
        });
      },
      assertFinalized(tx: unknown) {
        events.push("finalized");
        expect(tx).toBe(o.transaction);
        if (!finalized || state.dropFinal) throw new Error("Not finalized");
        expect(events).toContain("commit");
        return deadline;
      },
    };
  });
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const run = vi.fn(async (work: (tx: { query: typeof query }) => Promise<unknown>) => {
    events.push("begin");
    try {
      const result = await work({ query });
      events.push("commit");
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    }
  });
  const authenticate = vi.fn(async () => {
    events.push("csrf");
    return { sessionReference: id(5) };
  });
  let reference = 10;
  const options = {
    persistence: {
      now: () => state.clock,
      transactions: { run },
      identity: { hasher: {} },
      currentActor: async () => undefined,
      validateAssociation: async () => true,
    },
    authentication: { authorize: authenticate },
    nextReference: vi.fn(() => id(reference++)),
  };
  // Controlled composition transport and actual owner packet shapes. This is not
  // encrypted Session/IAM, native Store persistence or independent Audit proof.
  const service = createMerchantStoreSetupReferences(
    options as unknown as Parameters<typeof createMerchantStoreSetupReferences>[0],
  );
  return { service, state, scope, events, handles, options, authenticate, query };
}
const write = (f: ReturnType<typeof fixture>, kind: StoreSetupReferenceKind = "Address") =>
  f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    kind,
    command: body(kind),
  });
it("ReadAll uses actual scope and current reader after owning COMMIT without complete base or allocation", async () => {
  const f = fixture(),
    result = await f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) });
  expect(result).toMatchObject({
    profile: "StoreSetupReferencesCurrentV1",
    ...scope4,
    address: null,
    contact: null,
    businessReferenceValidation: "NotEvaluated",
  });
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(mocks.base).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(f.events.slice(-2)).toEqual(["commit", "finalized"]);
});
it.each(["Address", "Contact"] as const)(
  "saves closed %s content with fixed scope/kind and original intent-only Audit",
  async (kind) => {
    const f = fixture(),
      result = await write(f, kind);
    expect(result).toMatchObject({
      outcome: "Committed",
      kind,
      snapshot: {
        kind,
        revision: 1,
        content: kind === "Address" ? address : contact,
        authoredByReference: scope4.actorReference,
      },
    });
    expect(result.intentDigest).toBe(
      hash({
        profile: "StoreSetupReferenceSaveV1",
        ...scope4,
        kind,
        operationReference: id(8),
        expectedReference: null,
        expectedRevision: 0,
        content: kind === "Address" ? address : contact,
        purposeCode: "STORE_SETUP_REFERENCE",
      }),
    );
    const audit = mocks.audit.mock.calls[0]?.[1];
    expect(audit.afterSummary).toEqual({ intentDigest: result.intentDigest });
    expect(audit.actor).toEqual({ type: "User", reference: scope4.actorReference });
    expect(audit).not.toHaveProperty("content");
    expect(audit.targetType).toBe("StoreSetupReference");
    expect(f.events.indexOf("csrf")).toBeLessThan(f.events.indexOf("begin"));
    expect(f.events.indexOf("owner final")).toBeLessThan(f.events.indexOf("commit"));
    expect(mocks.base).not.toHaveBeenCalled();
  },
);
it("Resolve absent records exact original pins/digest without today content or complete base", async () => {
  const f = fixture(),
    intentDigest = "sha256:" + "a".repeat(64);
  const result = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    kind: "Contact",
    command: {
      command: "ResolveOriginal",
      operationReference: id(8),
      expectedReference: id(60),
      expectedRevision: 3,
      intentDigest,
    },
  });
  expect(result).toMatchObject({
    outcome: "Abandoned",
    kind: "Contact",
    snapshot: null,
    expectedReference: id(60),
    expectedRevision: 3,
    intentDigest,
  });
  expect(mocks.audit.mock.calls[0]?.[1].afterSummary).toEqual({ intentDigest });
  expect(mocks.base).not.toHaveBeenCalled();
});
it("historical author stays distinct from authorized current reader", async () => {
  const f = fixture();
  f.state.historical = true;
  const result = await f.service.read({
    sessionCookie: "synthetic",
    expectedStoreReference: id(3),
  });
  expect(result.actorReference).toBe(id(4));
  expect(result.address?.authoredByReference).toBe(id(88));
});
it.each(["tenantReference", "brandReference", "storeReference", "actorReference"] as const)(
  "refuses mismatched %s before owner or allocation",
  async (key) => {
    const f = fixture();
    await expect(
      f.service.write({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        kind: "Address",
        expectedScope: { ...scope4, [key]: id(99) },
        command: body(),
      }),
    ).rejects.toHaveProperty("code", "STORE_SETUP_REFERENCE_PERMISSION_DENIED");
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(f.options.nextReference).not.toHaveBeenCalled();
  },
);
it("route Store mismatch refuses owning ReadAll", async () => {
  const f = fixture();
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(99) }),
  ).rejects.toHaveProperty("code", "STORE_SETUP_REFERENCE_PERMISSION_DENIED");
  expect(mocks.owner).not.toHaveBeenCalled();
});
it("route kind cannot accept an Address body on Contact", async () => {
  const f = fixture();
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      kind: "Contact",
      expectedScope: scope4,
      command: body(),
    }),
  ).rejects.toHaveProperty("code", "STORE_SETUP_REFERENCE_INPUT_INVALID");
  expect(f.authenticate).not.toHaveBeenCalled();
});
it("actual owner packet wrong kind is rejected without COMMIT", async () => {
  const f = fixture();
  f.state.wrongKind = true;
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("CSRF denial never enters the transaction", async () => {
  const f = fixture();
  f.authenticate.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  await expect(write(f)).rejects.toHaveProperty("code", "STORE_SETUP_REFERENCE_PERMISSION_DENIED");
  expect(f.events).not.toContain("begin");
});
it("known current scope denial remains bounded PermissionDenied", async () => {
  const f = fixture();
  mocks.scope.mockRejectedValueOnce(new Error("STORE_SERVICE_PERMISSION_DENIED"));
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) }),
  ).rejects.toHaveProperty("code", "STORE_SETUP_REFERENCE_PERMISSION_DENIED");
});
it("withdrawn current IAM rolls back after owning Audit before terminal result", async () => {
  const f = fixture();
  mocks.audit.mockImplementationOnce(async (_tx, audit) => {
    validateAuditRecord(audit, Date.parse(at));
    f.state.allowed = false;
  });
  await expect(write(f)).rejects.toHaveProperty("code", "STORE_SETUP_REFERENCE_PERMISSION_DENIED");
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("current read lease clamps to final shortest authority", async () => {
  const f = fixture();
  f.state.shorten = true;
  const result = await f.service.read({
    sessionCookie: "synthetic",
    expectedStoreReference: id(3),
  });
  expect(result.validUntil).toBe(new Date(Date.parse(at) + 1000).toISOString());
});
it("expired held authority refuses final COMMIT", async () => {
  const f = fixture();
  f.state.expire = true;
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("missing owning finalization never yields a successful read", async () => {
  const f = fixture();
  f.state.dropFinal = true;
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) }),
  ).rejects.toThrow();
});
it("captured allocation port drift rejects before request", async () => {
  const f = fixture();
  f.options.nextReference = vi.fn(() => id(99));
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) }),
  ).rejects.toHaveProperty("code", "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toEqual([]);
});
it("detaches original content and expected pins before asynchronous authentication", async () => {
  const f = fixture(),
    command = { ...body(), content: { ...address, addressLines: [...address.addressLines] } };
  f.authenticate.mockImplementationOnce(async () => {
    command.content.addressLines[0] = "Changed local draft";
    command.expectedRevision = 9;
    return { sessionReference: id(5) };
  });
  const result = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    kind: "Address",
    expectedScope: scope4,
    command,
  });
  expect(result).toMatchObject({ expectedRevision: 0, snapshot: { content: address } });
});
it("Audit failure poisons result and rolls back", async () => {
  const f = fixture();
  f.state.auditFailure = true;
  await expect(write(f)).rejects.toThrow();
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("captured clock cannot be replaced even with the same returned instant", async () => {
  const f = fixture();
  f.options.persistence.now = () => at;
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) }),
  ).rejects.toHaveProperty("code", "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toEqual([]);
});
it("unknown authentication dependency is not exposed as a permission decision", async () => {
  const f = fixture();
  f.authenticate.mockRejectedValueOnce(new Error("Synthetic private failure"));
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.events).not.toContain("begin");
});
