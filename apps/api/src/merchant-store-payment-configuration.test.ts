import { beforeEach, expect, it, vi } from "vitest";
import { BrowserSessionError } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import {
  parseStorePaymentConfigurationVersion,
  parseStorePaymentConfigurationReceipt,
  parseStorePaymentConfigurationCurrent,
  storePaymentConfigurationRequiredFields,
  type StorePaymentConfigurationStoreOptions,
  type StorePaymentConfigurationSave,
  type StorePaymentConfigurationResolve,
} from "@rms/payment";
import { createMerchantStorePaymentConfiguration } from "./merchant-store-payment-configuration.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), owner: vi.fn(), audit: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresStorePaymentConfigurationStore: mocks.owner,
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
const content = {
  customerOnlineCardEnabled: true,
  staffTerminalCardPresentEnabled: false,
  staffTerminalInteracEnabled: true,
};
const body = () => ({
  command: "SaveConfiguration",
  operationReference: id(8),
  expectedConfigurationReference: null,
  expectedRevision: 0,
  content: { ...content },
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
    wrongMode: false,
    historical: false,
  };
  const allowed = vi.fn(async () => state.allowed);
  const scope = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    actorReference: id(4),
    sessionReference: id(5),
    store: { storeReference: id(3), currencyCode: "CAD" },
    allowed,
    authorizationValidUntil: () => state.until,
  };
  mocks.scope.mockImplementation(async (_tx, _cookie, action, expectedSession) => {
    events.push("scope");
    expect(action).toBe("organization.manage");
    if (expectedSession !== undefined) expect(expectedSession).toBe(id(5));
    return scope;
  });
  mocks.audit.mockImplementation(async (_tx, input) => {
    validateAuditRecord(input, Date.parse(state.clock));
    events.push("audit");
    if (state.auditFailure) throw new Error("Synthetic audit failure");
  });
  const handles: { owner?: StorePaymentConfigurationStoreOptions } = {};
  mocks.owner.mockImplementation((o: StorePaymentConfigurationStoreOptions) => {
    handles.owner = o;
    let active = false,
      guarded = false,
      finalized = false,
      registered = false,
      deadline = o.originalValidUntil;
    let command: StorePaymentConfigurationSave | StorePaymentConfigurationResolve | null = null;
    let mode: "ReadCurrent" | "Save" | "Resolve" = "ReadCurrent";
    const hold = async () => {
      const result = await o.authority.holdUntilTransactionCompletes(o.transaction, {
        ...scope4,
        permission: "organization.manage",
        purposeCode: "STORE_PAYMENT_CONFIGURATION",
        mode: state.wrongMode ? "ReadVersion" : mode,
        currencyCode: "CAD",
        configurationReference: null,
        requiredFields: storePaymentConfigurationRequiredFields,
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
          ? parseStorePaymentConfigurationVersion({
              profile: "StorePaymentConfigurationV1",
              tenantReference: id(1),
              brandReference: id(2),
              storeReference: id(3),
              configurationReference: id(90),
              revision: 1,
              authoredByReference: id(88),
              previousConfigurationReference: null,
              content,
              currencyCode: "CAD",
              createdAt: at,
              updatedAt: at,
              dataClassification: "Internal",
            })
          : null;
        return parseStorePaymentConfigurationCurrent({
          profile: "StorePaymentConfigurationCurrentV1",
          ...scope4,
          snapshot: historical,
          observedAt: at,
          validUntil: deadline,
          providerReadiness: "NotEvaluated",
        });
      },
      async save(c: StorePaymentConfigurationSave) {
        command = c;
        mode = "Save";
        await enter();
        const snapshot = parseStorePaymentConfigurationVersion({
          profile: "StorePaymentConfigurationV1",
          tenantReference: o.tenantReference,
          brandReference: o.brandReference,
          storeReference: o.storeReference,
          configurationReference: o.references.nextReference("Configuration"),
          revision: 1,
          authoredByReference: o.actorReference,
          previousConfigurationReference: null,
          content: c.content,
          currencyCode: "CAD",
          createdAt: at,
          updatedAt: at,
          dataClassification: "Internal",
        });
        const auditReference = o.references.nextReference("Audit"),
          intentDigest = hash(c);
        await o.appendAudit(o.transaction, {
          ...scope4,
          operationReference: c.operationReference,
          auditReference,
          intentDigest,
          purposeCode: "STORE_PAYMENT_CONFIGURATION",
          mode: "Save",
          occurredAt: at,
        });
        active = false;
        return parseStorePaymentConfigurationReceipt({
          profile: "StorePaymentConfigurationReceiptV1",
          ...scope4,
          operationReference: c.operationReference,
          expectedConfigurationReference: c.expectedConfigurationReference,
          expectedRevision: c.expectedRevision,
          intentDigest,
          outcome: "Committed",
          snapshot,
          auditReference,
          occurredAt: at,
        });
      },
      async resolve(c: StorePaymentConfigurationResolve) {
        command = c;
        mode = "Resolve";
        await enter();
        const auditReference = o.references.nextReference("Audit");
        await o.appendAudit(o.transaction, {
          ...scope4,
          operationReference: c.operationReference,
          auditReference,
          intentDigest: c.intentDigest,
          purposeCode: "STORE_PAYMENT_CONFIGURATION",
          mode: "Abandon",
          occurredAt: at,
        });
        active = false;
        return parseStorePaymentConfigurationReceipt({
          profile: "StorePaymentConfigurationReceiptV1",
          ...scope4,
          operationReference: c.operationReference,
          expectedConfigurationReference: c.expectedConfigurationReference,
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
  // encrypted Session/IAM, native Payment persistence or independent Audit proof.
  const service = createMerchantStorePaymentConfiguration(
    options as unknown as Parameters<typeof createMerchantStorePaymentConfiguration>[0],
  );
  return { service, state, scope, events, handles, options, authenticate, query };
}
const write = (f: ReturnType<typeof fixture>) =>
  f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: body(),
  });
const read = (f: ReturnType<typeof fixture>) =>
  f.service.read({
    sessionCookie: "synthetic",
    expectedStoreReference: id(3),
  });
it("reads genuine scoped owning current after COMMIT without allocations, Audit or Provider readiness", async () => {
  const f = fixture(),
    result = await read(f);
  expect(result).toMatchObject({
    profile: "StorePaymentConfigurationCurrentV1",
    ...scope4,
    snapshot: null,
    providerReadiness: "NotEvaluated",
  });
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(f.events.slice(-2)).toEqual(["commit", "finalized"]);
});
it("saves actual CAD channel rules and writes same-transaction intent-only Audit before COMMIT", async () => {
  const f = fixture(),
    result = await write(f);
  expect(result).toMatchObject({
    outcome: "Committed",
    snapshot: {
      content,
      currencyCode: "CAD",
      revision: 1,
      authoredByReference: scope4.actorReference,
    },
  });
  expect(result.intentDigest).toBe(
    hash({
      profile: "StorePaymentConfigurationSaveV1",
      ...scope4,
      operationReference: id(8),
      expectedConfigurationReference: null,
      expectedRevision: 0,
      content,
      purposeCode: "STORE_PAYMENT_CONFIGURATION",
    }),
  );
  const audit = mocks.audit.mock.calls[0]?.[1];
  expect(audit).toBeDefined();
  expect(audit.afterSummary).toEqual({ intentDigest: result.intentDigest });
  expect(audit.actor).toEqual({ type: "User", reference: scope4.actorReference });
  expect(audit.actionCode).toBe("STORE_PAYMENT_CONFIGURATION_SAVED");
  expect(audit.targetType).toBe("StorePaymentConfiguration");
  expect(audit.targetId).toBe(id(8));
  expect(audit).not.toHaveProperty("content");
  expect(mocks.audit.mock.calls[0]?.[0]).toBe(f.handles.owner?.transaction);
  expect(f.events.indexOf("csrf")).toBeLessThan(f.events.indexOf("begin"));
  expect(f.events.indexOf("owner final")).toBeLessThan(f.events.indexOf("commit"));
});
it("keeps all disabled channels saved without claiming Provider readiness", async () => {
  const f = fixture();
  const result = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: {
      ...body(),
      content: {
        customerOnlineCardEnabled: false,
        staffTerminalCardPresentEnabled: false,
        staffTerminalInteracEnabled: false,
      },
    },
  });
  expect(result.snapshot?.content).toEqual({
    customerOnlineCardEnabled: false,
    staffTerminalCardPresentEnabled: false,
    staffTerminalInteracEnabled: false,
  });
});
it("resolves genuine absence using original pins and digest without channel content", async () => {
  const f = fixture(),
    intentDigest = "sha256:" + "a".repeat(64);
  const result = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: {
      command: "ResolveOriginal",
      operationReference: id(8),
      expectedConfigurationReference: id(60),
      expectedRevision: 3,
      intentDigest,
    },
  });
  expect(result).toMatchObject({
    outcome: "Abandoned",
    snapshot: null,
    expectedConfigurationReference: id(60),
    expectedRevision: 3,
    intentDigest,
  });
  expect(mocks.audit.mock.calls[0]?.[1].afterSummary).toEqual({ intentDigest });
  expect(mocks.audit.mock.calls[0]?.[1].actionCode).toBe(
    "STORE_PAYMENT_CONFIGURATION_ORIGINAL_ABANDONED",
  );
  expect(f.options.nextReference).toHaveBeenCalledTimes(1);
});
it("retains historical writer separately from authorized current reader", async () => {
  const f = fixture();
  f.state.historical = true;
  const result = await read(f);
  expect(result.actorReference).toBe(id(4));
  expect(result.snapshot?.authoredByReference).toBe(id(88));
});
it.each(["tenantReference", "brandReference", "storeReference", "actorReference"] as const)(
  "refuses %s substitution before owner or allocation",
  async (key) => {
    const f = fixture();
    await expect(
      f.service.write({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        expectedScope: { ...scope4, [key]: id(99) },
        command: body(),
      }),
    ).rejects.toHaveProperty("code", "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED");
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(f.options.nextReference).not.toHaveBeenCalled();
  },
);
it("refuses selected Store mismatch on current read", async () => {
  const f = fixture();
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(99) }),
  ).rejects.toHaveProperty("code", "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED");
  expect(mocks.owner).not.toHaveBeenCalled();
});
it("requires actual selected Store CAD rather than defaulting missing or foreign currency", async () => {
  const f = fixture();
  f.scope.store.currencyCode = "USD";
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  );
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it.each([
  { ...body(), accountReference: id(90) },
  { ...body(), content: { ...content, providerReady: true } },
  { ...body(), content: { ...content, customerOnlineCardEnabled: "true" } },
])("rejects malformed or credential-bearing body before authentication", async (command) => {
  const f = fixture();
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      command,
    }),
  ).rejects.toHaveProperty("code", "STORE_PAYMENT_CONFIGURATION_INPUT_INVALID");
  expect(f.authenticate).not.toHaveBeenCalled();
});
it("rejects wrong owning authority mode and rolls back", async () => {
  const f = fixture();
  f.state.wrongMode = true;
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("denied CSRF never begins a transaction", async () => {
  const f = fixture();
  f.authenticate.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED",
  );
  expect(f.events).not.toContain("begin");
});
it("preserves known organization scope denial", async () => {
  const f = fixture();
  mocks.scope.mockRejectedValueOnce(new Error("STORE_SERVICE_PERMISSION_DENIED"));
  await expect(read(f)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED",
  );
});
it("withdrawn authority after Audit prevents terminal success and COMMIT", async () => {
  const f = fixture();
  mocks.audit.mockImplementationOnce(async (_tx, audit) => {
    validateAuditRecord(audit, Date.parse(at));
    f.state.allowed = false;
  });
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED",
  );
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("clamps current packet to final shortest authorization lease", async () => {
  const f = fixture();
  f.state.shorten = true;
  const result = await read(f);
  expect(result.validUntil).toBe(new Date(Date.parse(at) + 1000).toISOString());
});
it("original deadline expiry during owning guard rolls back", async () => {
  const f = fixture();
  f.state.expire = true;
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("cannot return successful current packet without owning finalization", async () => {
  const f = fixture();
  f.state.dropFinal = true;
  await expect(read(f)).rejects.toThrow();
});
it("captures allocation and clock port identity", async () => {
  const f = fixture();
  f.options.nextReference = vi.fn(() => id(99));
  await expect(read(f)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.events).toEqual([]);
  const g = fixture();
  g.options.persistence.now = () => at;
  await expect(read(g)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  );
  expect(g.events).toEqual([]);
});
it("detaches channel booleans and CAS pins before asynchronous authentication", async () => {
  const f = fixture(),
    command = body();
  f.authenticate.mockImplementationOnce(async () => {
    command.content.customerOnlineCardEnabled = false;
    command.expectedRevision = 9;
    return { sessionReference: id(5) };
  });
  const result = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command,
  });
  expect(result).toMatchObject({ expectedRevision: 0, snapshot: { content } });
});
it("Audit transport failure rolls back without exposing private error", async () => {
  const f = fixture();
  f.state.auditFailure = true;
  await expect(write(f)).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("unknown authentication failure remains bounded unavailable", async () => {
  const f = fixture();
  f.authenticate.mockRejectedValueOnce(new Error("Synthetic private failure"));
  await expect(write(f)).rejects.toHaveProperty(
    "code",
    "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.events).not.toContain("begin");
});
