import { beforeEach, expect, it, vi } from "vitest";
import { BrowserSessionError } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import {
  createUnconfiguredStoreSetupDraftContent,
  createUnconfiguredStoreSetupDraftContentV2,
  createStoreSetupDraft,
  parseStoreSetupCurrent,
  parseStoreSetupOperationReceipt,
  storeSetupDraftOperationFields,
  StoreSetupOperationError,
  type StoreSetupDraftStoreOptions,
  type StoreSetupOperationReceipt,
} from "@rms/store";
import { createMerchantStoreSetup } from "./merchant-store-setup.js";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  owner: vi.fn(),
  base: vi.fn(),
  audit: vi.fn(),
  classifications: vi.fn(),
}));
vi.mock("./merchant-store-fee-context-classifications.js", async (original) => ({
  ...(await original<typeof import("./merchant-store-fee-context-classifications.js")>()),
  createMerchantStoreFeeContextClassifications: mocks.classifications,
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPostgresStoreSetupDraftStore: mocks.owner,
  createPostgresStoreConfigurationAuthoringSource: () => mocks.base,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T14:00:00.000Z";
const scope4 = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const body = () => ({
  command: "SaveDraft",
  operationReference: id(8),
  expectedSetupReference: null,
  expectedRevision: 0,
  content: createUnconfiguredStoreSetupDraftContent(),
});

beforeEach(() => vi.resetAllMocks());
function fixture() {
  const events: string[] = [];
  const state = {
    clock: at,
    allowed: true,
    until: new Date(Date.parse(at) + 5000).toISOString(),
    base: id(6),
    auditFailure: false,
    baseDrift: false,
    shortenOnGuard: false,
    dropFinal: false,
    replay: false,
    classificationMissing: false,
    classificationDenied: false,
  };
  const allowed = vi.fn(async () => state.allowed);
  const scope = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    actorReference: id(4),
    sessionReference: id(5),
    store: {
      storeReference: id(3),
      code: "SYNTHETIC_STORE",
      displayName: "Synthetic Store",
      locale: "fr-CA",
      currencyCode: "CAD",
      timeZone: "America/Toronto",
      version: 2,
    },
    allowed,
    authorizationValidUntil: () => state.until,
  };
  mocks.scope.mockImplementation(async (_tx, _cookie, action, expectedSession) => {
    events.push("scope");
    expect(action).toBe("organization.manage");
    if (expectedSession !== undefined) expect(expectedSession).toBe(id(5));
    return scope;
  });
  mocks.base.mockImplementation(async () => {
    events.push("base");
    return { configurationReference: state.base };
  });
  mocks.audit.mockImplementation(async (_tx, input) => {
    validateAuditRecord(input, Date.parse(state.clock));
    events.push("audit");
    if (state.auditFailure) throw new Error("synthetic audit unavailable");
    return { auditId: input.auditId };
  });
  mocks.classifications.mockImplementation(
    (
      options: Parameters<
        typeof import("./merchant-store-fee-context-classifications.js").createMerchantStoreFeeContextClassifications
      >[0],
    ) => {
      let complete = false;
      return {
        async read() {
          if (state.classificationDenied)
            throw new StoreSetupOperationError("STORE_SETUP_OPERATION_PERMISSION_DENIED");
          await options.fresh();
          await options.registerBeforeCommit(
            options.transaction,
            async () => {
              await options.fresh();
            },
            () => {
              options.check();
              complete = true;
            },
          );
          return {
            profile: "TaxConfigClassificationChoicesV1",
            ...scope4,
            registryReference: id(40),
            versionReference: id(41),
            registryVersion: 1,
            snapshotDigest: hash("registry"),
            defaultLocale: "en-CA",
            choices: state.classificationMissing
              ? []
              : [
                  {
                    classificationReference: id(42),
                    code: "STANDARD",
                    localizedNames: { "en-CA": "Standard" },
                    lifecycle: "Active",
                  },
                ],
            observedAt: options.check(),
            validUntil: options.deadline(),
            sourceQualification: "NotEvaluated",
          };
        },
        assertFinalized() {
          if (!complete || !events.includes("commit")) throw new Error("registry not finalized");
          options.check();
          return options.deadline();
        },
      };
    },
  );
  const handles: { owner?: StoreSetupDraftStoreOptions; receipt?: StoreSetupOperationReceipt } = {};
  mocks.owner.mockImplementation((o: StoreSetupDraftStoreOptions) => {
    handles.owner = o;
    let active = false,
      guarded = false,
      finalized = false,
      registered = false;
    let command: Parameters<typeof o.authority.holdUntilTransactionCompletes>[1]["command"] = null;
    let mode: "Read" | "Save" | "Resolve" = "Read";
    const hold = () =>
      o.authority.holdUntilTransactionCompletes(
        o.transaction,
        Object.freeze({
          tenantReference: o.tenantReference,
          brandReference: o.brandReference,
          storeReference: o.storeReference,
          actorReference: o.actorReference,
          permission: "organization.manage",
          purposeCode: "STORE_SETUP_DRAFT",
          mode,
          requiredFields: storeSetupDraftOperationFields,
          command,
          observedAt: o.clock.now(),
          validUntil: o.originalValidUntil,
        }),
      );
    const enter = async () => {
      if (active || guarded) throw new Error("closed owning phase");
      active = true;
      if (!registered) {
        registered = true;
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            if (active || guarded) throw new Error("invalid owner guard");
            events.push("owner guard");
            if (state.baseDrift) state.base = id(7);
            if (state.shortenOnGuard) state.until = new Date(Date.parse(at) + 1000).toISOString();
            await hold();
            guarded = true;
          },
          () => {
            events.push("owner final");
            if (!guarded) throw new Error("missing async guard");
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
        return parseStoreSetupCurrent({
          profile: "StoreSetupCurrentV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          readerActorReference: scope4.actorReference,
          snapshot: null,
          observedAt: at,
          validUntil: o.originalValidUntil,
          businessReferenceValidation: "NotEvaluated",
        });
      },
      async save(c: NonNullable<typeof command>) {
        command = c;
        mode = "Save";
        await enter();
        if (state.replay && handles.receipt) {
          active = false;
          return handles.receipt;
        }
        const result = await o.withCurrentSaveScope(
          o.transaction,
          { ...scope4, observedAt: at, validUntil: o.originalValidUntil },
          async (actual) => {
            const snapshot = createStoreSetupDraft(
              {
                profile:
                  "content" in c && c.content.feeContexts !== undefined
                    ? "StoreSetupDraftV2"
                    : "StoreSetupDraftV1",
                setupDraftReference: o.references.nextReference("SetupDraft"),
                tenantReference: id(1),
                brandReference: id(2),
                storeReference: id(3),
                revision: 1,
                authoredByReference: scope4.actorReference,
                defaultLocale: actual.defaultLocale,
                currencyCode: actual.currencyCode,
                baseConfigurationReference: actual.baseConfigurationReference,
                content: "content" in c ? c.content : createUnconfiguredStoreSetupDraftContent(),
                createdAt: at,
                updatedAt: at,
                purposeCode: "STORE_SETUP_DRAFT",
                dataClassification: "ConfigurationMetadata",
              },
              actual,
            );
            const auditReference = o.references.nextReference("Audit"),
              intentDigest = hash(c);
            await o.appendAudit(o.transaction, {
              ...scope4,
              auditReference,
              operationReference: c.operationReference,
              intentDigest,
              purposeCode: "STORE_SETUP_DRAFT",
              mode: "Save",
              occurredAt: at,
            });
            return parseStoreSetupOperationReceipt({
              profile: "StoreSetupOperationReceiptV1",
              ...scope4,
              operationReference: c.operationReference,
              expectedSetupReference: null,
              expectedRevision: 0,
              purposeCode: "STORE_SETUP_DRAFT",
              intentDigest,
              outcome: "Committed",
              snapshot,
              auditReference,
              occurredAt: at,
            });
          },
        );
        active = false;
        handles.receipt = result;
        return result;
      },
      async resolve(c: NonNullable<typeof command>) {
        command = c;
        mode = "Resolve";
        await enter();
        const auditReference = o.references.nextReference("Audit");
        const intentDigest = "intentDigest" in c ? c.intentDigest : hash(c);
        await o.appendAudit(o.transaction, {
          ...scope4,
          auditReference,
          operationReference: c.operationReference,
          intentDigest,
          purposeCode: "STORE_SETUP_DRAFT",
          mode: "Abandon",
          occurredAt: at,
        });
        active = false;
        return parseStoreSetupOperationReceipt({
          profile: "StoreSetupOperationReceiptV1",
          ...scope4,
          operationReference: c.operationReference,
          expectedSetupReference: null,
          expectedRevision: 0,
          purposeCode: "STORE_SETUP_DRAFT",
          intentDigest,
          outcome: "Abandoned",
          snapshot: null,
          auditReference,
          occurredAt: at,
        });
      },
      assertFinalized(tx: unknown) {
        events.push("finalized");
        expect(tx).toBe(o.transaction);
        if (!finalized || state.dropFinal) throw new Error("owner not finalized");
        expect(events).toContain("commit");
        return o.originalValidUntil;
      },
    };
  });
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const run = vi.fn(async (work: (tx: { query: typeof query }) => Promise<unknown>) => {
    events.push("begin");
    try {
      const value = await work({ query });
      events.push("commit");
      return value;
    } catch (error) {
      events.push("rollback");
      throw error;
    }
  });
  const authenticate = vi.fn(async () => {
    events.push("csrf");
    return { sessionReference: id(5) };
  });
  let refs = 10;
  const options = {
    persistence: {
      now: () => state.clock,
      transactions: { run },
      identity: { hasher: {} },
      currentActor: async () => undefined,
      validateAssociation: async () => true,
    },
    authentication: { authorize: authenticate },
    nextReference: vi.fn(() => id(refs++)),
  };
  // Controlled composition ports, not encrypted Session/IAM or native database evidence.
  const service = createMerchantStoreSetup(
    options as unknown as Parameters<typeof createMerchantStoreSetup>[0],
  );
  return { service, state, scope, events, handles, query, options, authenticate };
}
it("reads truthful absent Setup with actual reader and bounded Store metadata after COMMIT", async () => {
  const f = fixture();
  const value = await f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) });
  expect(value).toMatchObject({
    profile: "StoreSetupWorkspaceV1",
    scope: scope4,
    store: { storeReference: id(3), locale: "fr-CA", version: 2 },
    setup: { snapshot: null, businessReferenceValidation: "NotEvaluated" },
  });
  expect(mocks.base).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(f.events.slice(-2)).toEqual(["commit", "finalized"]);
});
it("saves a partial draft through actual Audit validation and live base callback", async () => {
  const f = fixture();
  const receipt = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: body(),
  });
  expect(receipt).toMatchObject({
    outcome: "Committed",
    snapshot: { revision: 1, defaultLocale: "fr-CA", baseConfigurationReference: id(6) },
  });
  expect(f.events.indexOf("csrf")).toBeLessThan(f.events.indexOf("begin"));
  expect(mocks.audit).toHaveBeenCalledOnce();
  expect(mocks.base).toHaveBeenCalledTimes(2);
  expect(f.events.indexOf("owner final")).toBeLessThan(f.events.indexOf("commit"));
});
it("resolves absent originals with real Audit append but no current base qualification", async () => {
  const f = fixture();
  const receipt = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: {
      command: "ResolveOriginal",
      operationReference: id(8),
      expectedSetupReference: null,
      expectedRevision: 0,
      intentDigest: `sha256:${"a".repeat(64)}`,
    },
  });
  expect(receipt).toMatchObject({ outcome: "Abandoned", snapshot: null });
  expect(mocks.base).not.toHaveBeenCalled();
  expect(mocks.audit).toHaveBeenCalledOnce();
});
it("rejects a route Store different from the selected Store before owning read", async () => {
  const f = fixture();
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(9) }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_PERMISSION_DENIED" });
  expect(mocks.owner).not.toHaveBeenCalled();
});
it("maps only the known live scope denial to bounded Store PermissionDenied", async () => {
  const f = fixture();
  mocks.scope.mockRejectedValueOnce(new Error("STORE_SERVICE_PERMISSION_DENIED"));
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_PERMISSION_DENIED" });
  mocks.scope.mockRejectedValueOnce(new Error("synthetic unknown dependency"));
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("rolls back when original current authorization is withdrawn before owning guard", async () => {
  const f = fixture();
  mocks.audit.mockImplementationOnce(async (_tx, input) => {
    validateAuditRecord(input, Date.parse(f.state.clock));
    f.state.allowed = false;
  });
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      command: body(),
    }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_PERMISSION_DENIED" });
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("rejects late base drift under its real final re-read", async () => {
  const f = fixture();
  f.state.baseDrift = true;
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      command: body(),
    }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_VERSION_CONFLICT" });
  expect(f.events).toContain("rollback");
});
it("Audit persistence failure never returns a terminal receipt", async () => {
  const f = fixture();
  f.state.auditFailure = true;
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      command: body(),
    }),
  ).rejects.toThrow();
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("clamps read lease to a genuinely shortened final authority observation", async () => {
  const f = fixture();
  f.state.shortenOnGuard = true;
  const value = await f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) });
  expect(value).toMatchObject({
    setup: { validUntil: new Date(Date.parse(at) + 1000).toISOString() },
  });
});
it("rejects missing source finalization even when a runner returned a value", async () => {
  const f = fixture();
  f.state.dropFinal = true;
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) }),
  ).rejects.toThrow();
});
it("captured reference and clock ports cannot be substituted mid-request", async () => {
  const f = fixture();
  f.options.nextReference = vi.fn(() => id(99));
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toEqual([]);
});
it("original Save bytes are detached before asynchronous CSRF admission", async () => {
  const f = fixture();
  const command = body();
  f.authenticate.mockImplementationOnce(async () => {
    command.expectedRevision = 1;
    return { sessionReference: id(5) };
  });
  const value = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command,
  });
  expect(value).toMatchObject({ expectedRevision: 0, outcome: "Committed" });
});
it("keeps replay outside current base qualification and returns immutable original", async () => {
  const f = fixture();
  const first = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: body(),
  });
  if ("setup" in first) throw new Error("expected receipt");
  mocks.owner.mockImplementationOnce((o: StoreSetupDraftStoreOptions) => {
    let done = false,
      final = false;
    return {
      async save() {
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            await o.authority.holdUntilTransactionCompletes(o.transaction, {
              ...scope4,
              permission: "organization.manage",
              purposeCode: "STORE_SETUP_DRAFT",
              mode: "Save",
              requiredFields: storeSetupDraftOperationFields,
              command: {
                profile: "StoreSetupSaveV1",
                ...scope4,
                operationReference: id(8),
                expectedSetupReference: null,
                expectedRevision: 0,
                purposeCode: "STORE_SETUP_DRAFT",
                content: body().content,
              },
              observedAt: at,
              validUntil: o.originalValidUntil,
            });
            done = true;
          },
          () => {
            if (!done) throw new Error("missing guard");
            final = true;
          },
        );
        return first;
      },
      assertFinalized() {
        if (!final) throw new Error("missing final");
        return o.originalValidUntil;
      },
    };
  });
  mocks.base.mockClear();
  mocks.audit.mockClear();
  f.state.base = id(99);
  const replay = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: body(),
  });
  expect(replay).toBe(first);
  expect(mocks.base).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("honors the original five-second deadline without extending it after slow authorization", async () => {
  const f = fixture();
  f.authenticate.mockImplementationOnce(async () => {
    f.state.clock = new Date(Date.parse(at) + 5000).toISOString();
    return { sessionReference: id(5) };
  });
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      command: body(),
    }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).not.toContain("begin");
});
it.each(["tenantReference", "brandReference", "storeReference", "actorReference"])(
  "rejects stale prepared %s before owner or Audit",
  async (key) => {
    const f = fixture();
    await expect(
      f.service.write({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command: body(),
        expectedScope: { ...scope4, [key]: id(99) },
      }),
    ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_PERMISSION_DENIED" });
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(f.events).toContain("rollback");
  },
);
it("refuses Session Store and Actor changes during asynchronous CSRF admission", async () => {
  const f = fixture();
  f.authenticate.mockImplementationOnce(async () => {
    f.scope.store.storeReference = id(99);
    f.scope.actorReference = id(98);
    return { sessionReference: id(5) };
  });
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command: body(),
      expectedScope: scope4,
    }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_PERMISSION_DENIED" });
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("detaches the expected scope before asynchronous authentication", async () => {
  const f = fixture();
  const preparedScope = { ...scope4 };
  f.authenticate.mockImplementationOnce(async () => {
    preparedScope.storeReference = id(99);
    return { sessionReference: id(5) };
  });
  expect(
    await f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command: body(),
      expectedScope: preparedScope,
    }),
  ).toMatchObject({ outcome: "Committed", storeReference: id(3) });
});
it("rejects scope getters and foreign fields without executing accessors", async () => {
  const f = fixture();
  let calls = 0;
  const unsafe = { ...scope4 };
  Object.defineProperty(unsafe, "actorReference", {
    enumerable: true,
    get() {
      calls++;
      return id(4);
    },
  });
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command: body(),
      expectedScope: unsafe,
    }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_INPUT_INVALID" });
  expect(calls).toBe(0);
  expect(f.authenticate).not.toHaveBeenCalled();
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      command: body(),
      expectedScope: { ...scope4, extra: true },
    }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_INPUT_INVALID" });
});
it("does not append a Resolve Audit for a different original digest", async () => {
  const f = fixture();
  mocks.owner.mockImplementationOnce((o: StoreSetupDraftStoreOptions) => ({
    resolve: async () =>
      o.appendAudit(o.transaction, {
        ...scope4,
        auditReference: id(10),
        operationReference: id(8),
        intentDigest: `sha256:${"b".repeat(64)}`,
        purposeCode: "STORE_SETUP_DRAFT",
        mode: "Abandon",
        occurredAt: at,
      }),
  }));
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      command: {
        command: "ResolveOriginal",
        operationReference: id(8),
        expectedSetupReference: null,
        expectedRevision: 0,
        intentDigest: `sha256:${"a".repeat(64)}`,
      },
    }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE" });
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(f.events).toContain("rollback");
});
it.each(["BROWSER_SESSION_DENIED", "BROWSER_SESSION_INPUT_INVALID"] as const)(
  "maps authentic %s authentication refusal before owning work",
  async (code) => {
    const f = fixture();
    f.authenticate.mockRejectedValueOnce(new BrowserSessionError(code));
    await expect(
      f.service.write({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        expectedScope: scope4,
        command: body(),
      }),
    ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_PERMISSION_DENIED" });
    expect(f.query).not.toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  },
);
it.each([
  new Error("synthetic dependency failure"),
  { code: "BROWSER_SESSION_DENIED" },
  new BrowserSessionError("BROWSER_SESSION_VERSION_CONFLICT"),
  new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID"),
])(
  "keeps unknown or well-formed-credential authentication dependency failures unavailable",
  async (error) => {
    const f = fixture();
    f.authenticate.mockRejectedValueOnce(error);
    await expect(
      f.service.write({
        sessionCookie: "A".repeat(43),
        csrf: "B".repeat(43),
        expectedScope: scope4,
        command: body(),
      }),
    ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE" });
    expect(f.query).not.toHaveBeenCalled();
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  },
);
it("maps authentic expired-session read refusal before owning reads", async () => {
  const f = fixture();
  mocks.scope.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  await expect(
    f.service.read({ sessionCookie: "A".repeat(43), expectedStoreReference: id(3) }),
  ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_PERMISSION_DENIED" });
  expect(f.query).not.toHaveBeenCalled();
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("does not reinterpret an unknown current-session read error as PermissionDenied", async () => {
  const f = fixture();
  mocks.scope.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID"));
  await expect(
    f.service.read({ sessionCookie: "A".repeat(43), expectedStoreReference: id(3) }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});

const feeBody = () => ({
  ...body(),
  content: {
    ...createUnconfiguredStoreSetupDraftContentV2(),
    feeContexts: {
      state: "Configured",
      value: [
        {
          chargeType: "ServiceCharge",
          state: "Enabled",
          taxClassificationReference: id(42),
          orderTypes: ["Pickup"],
        },
        { chargeType: "DeliveryFee", state: "Disabled" },
        { chargeType: "Tip", state: "Unconfigured" },
      ],
    },
  },
});
it("returns actual classification choices through the same held Store scope without Setup or write allocations", async () => {
  const f = fixture();
  const value = await f.service.classifications({
    sessionCookie: "synthetic",
    expectedStoreReference: id(3),
  });
  expect(value).toMatchObject({
    profile: "TaxConfigClassificationChoicesV1",
    ...scope4,
    sourceQualification: "NotEvaluated",
    choices: [{ classificationReference: id(42) }],
  });
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(f.events).toContain("commit");
});
it("authenticates enabled V2 selections before base read and Audit then retains the exact V2 original", async () => {
  const f = fixture();
  const command = feeBody();
  const receipt = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command,
  });
  expect(receipt.snapshot?.profile).toBe("StoreSetupDraftV2");
  expect(mocks.classifications).toHaveBeenCalledTimes(1);
  expect(receipt.intentDigest).toBe(
    hash({
      profile: "StoreSetupSaveV2",
      ...scope4,
      operationReference: command.operationReference,
      expectedSetupReference: null,
      expectedRevision: 0,
      purposeCode: "STORE_SETUP_DRAFT",
      content: command.content,
    }),
  );
});
it.each(["classificationMissing", "classificationDenied"] as const)(
  "refuses %s before allocating a fresh V2 write",
  async (key) => {
    const f = fixture();
    f.state[key] = true;
    await expect(
      f.service.write({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        expectedScope: scope4,
        command: feeBody(),
      }),
    ).rejects.toMatchObject({
      code:
        key === "classificationDenied"
          ? "STORE_SETUP_OPERATION_PERMISSION_DENIED"
          : "STORE_SETUP_OPERATION_INPUT_INVALID",
    });
    expect(mocks.base).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(f.events).toContain("rollback");
  },
);
it("existing V2 original replay does not requalify today's registry", async () => {
  const f = fixture();
  const command = feeBody();
  const receipt = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command,
  });
  f.state.replay = true;
  f.state.classificationDenied = true;
  const calls = mocks.classifications.mock.calls.length;
  expect(
    await f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      command,
    }),
  ).toEqual(receipt);
  expect(mocks.classifications).toHaveBeenCalledTimes(calls);
});
it("V1 and explicitly disabled V2 fresh saves do not invent registry qualification", async () => {
  for (const content of [
    createUnconfiguredStoreSetupDraftContent(),
    {
      ...createUnconfiguredStoreSetupDraftContentV2(),
      feeContexts: {
        state: "Configured",
        value: [
          { chargeType: "ServiceCharge", state: "Disabled" },
          { chargeType: "DeliveryFee", state: "Disabled" },
          { chargeType: "Tip", state: "Disabled" },
        ],
      },
    },
  ]) {
    const f = fixture();
    await f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      command: { ...body(), content },
    });
  }
  expect(mocks.classifications).not.toHaveBeenCalled();
});
