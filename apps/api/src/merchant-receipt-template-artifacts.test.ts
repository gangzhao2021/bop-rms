import { beforeEach, expect, it, vi } from "vitest";
import { BrowserSessionError } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import {
  digitalReceiptRequiredFields,
  parseDigitalReceiptTemplateArtifactVersion,
  parseDigitalReceiptTemplateArtifactReceipt,
  parseDigitalReceiptTemplateArtifactCurrent,
  digitalReceiptTemplateArtifactRequiredFields,
  type DigitalReceiptTemplateArtifactStoreOptions,
  type DigitalReceiptTemplateArtifactSave,
  type DigitalReceiptTemplateArtifactResolve,
  type DigitalReceiptTemplateArtifactKind,
} from "@rms/printing-device";
import { createMerchantReceiptTemplateArtifacts } from "./merchant-receipt-template-artifacts.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), owner: vi.fn(), audit: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
vi.mock("@rms/printing-device", async (original) => ({
  ...(await original<typeof import("@rms/printing-device")>()),
  createPostgresDigitalReceiptTemplateArtifactStore: mocks.owner,
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
const layout = {
  profile: "AccessibleDigitalReceiptLayoutV1",
  dataContractVersion: 1,
  renderEngineVersion: 1,
  outputProfile: "AccessibleDigitalReceipt",
  requiredFields: [...digitalReceiptRequiredFields],
};
const compliance = {
  profile: "DigitalReceiptRequiredFieldRuleV1",
  dataContractVersion: 1,
  requiredFields: [...digitalReceiptRequiredFields],
  professionalReviewStatus: "NotEvaluated",
  legalConclusion: "NotEvaluated",
};
const body = (kind: DigitalReceiptTemplateArtifactKind = "Layout") => ({
  command: "SaveArtifact",
  operationReference: id(8),
  expectedArtifactReference: null,
  expectedRevision: 0,
  content: kind === "Layout" ? layout : compliance,
});
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const events: string[] = [];
  const state = {
    clock: at,
    allowed: true,
    editingAllowed: true,
    editingUntil: until,
    integrationDenied: false,
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
  const editingAllowed = vi.fn(async () => state.editingAllowed);
  const editingScope = {
    ...scope,
    selected: { ...scope.selected },
    context: { brand: { ...scope.context.brand } },
    store: { ...scope.store },
    allowed: editingAllowed,
    authorizationValidUntil: () => state.editingUntil,
  };
  mocks.scope.mockImplementation(async (_tx, _cookie, action, expectedSession) => {
    events.push("scope:" + action);
    if (expectedSession !== undefined) expect(expectedSession).toBe(id(5));
    if (action === "organization.manage") return scope;
    expect(action).toBe("integration.manage");
    if (state.integrationDenied) throw new Error("STORE_SERVICE_PERMISSION_DENIED");
    return editingScope;
  });
  mocks.audit.mockImplementation(async (_tx, input) => {
    validateAuditRecord(input, Date.parse(state.clock));
    events.push("audit");
    if (state.auditFailure) throw new Error("Synthetic audit failure");
  });
  const handles: { owner?: DigitalReceiptTemplateArtifactStoreOptions } = {};
  mocks.owner.mockImplementation((o: DigitalReceiptTemplateArtifactStoreOptions) => {
    handles.owner = o;
    let active = false,
      guarded = false,
      finalized = false,
      registered = false,
      deadline = o.originalValidUntil;
    let command: DigitalReceiptTemplateArtifactSave | DigitalReceiptTemplateArtifactResolve | null =
      null;
    let mode: "ReadAll" | "Save" | "Resolve" = "ReadAll";
    const hold = async () => {
      const result = await o.authority.holdUntilTransactionCompletes(o.transaction, {
        ...scope4,
        permission: command ? "integration.manage" : "organization.manage",
        purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
        mode,
        artifactKind: state.wrongKind ? "Compliance" : (command?.artifactKind ?? null),
        targetArtifactReference: null,
        requiredFields: digitalReceiptTemplateArtifactRequiredFields,
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
          ? parseDigitalReceiptTemplateArtifactVersion({
              profile: "DigitalReceiptTemplateArtifactV1",
              tenantReference: id(1),
              brandReference: id(2),
              storeReference: id(3),
              artifactKind: "Layout",
              artifactReference: id(90),
              revision: 1,
              authoredByReference: id(88),
              previousArtifactReference: null,
              content: layout,
              createdAt: at,
              updatedAt: at,
              dataClassification: "Internal",
            })
          : null;
        return parseDigitalReceiptTemplateArtifactCurrent({
          profile: "DigitalReceiptTemplateArtifactsCurrentV1",
          ...scope4,
          layout: historical,
          compliance: null,
          observedAt: at,
          validUntil: deadline,
          sourceQualification: "NotEvaluated",
        });
      },
      async save(c: DigitalReceiptTemplateArtifactSave) {
        command = c;
        mode = "Save";
        await enter();
        const snapshot = parseDigitalReceiptTemplateArtifactVersion({
          profile: "DigitalReceiptTemplateArtifactV1",
          tenantReference: o.tenantReference,
          brandReference: o.brandReference,
          storeReference: o.storeReference,
          artifactKind: c.artifactKind,
          artifactReference: o.references.nextReference("Artifact"),
          revision: 1,
          authoredByReference: o.actorReference,
          previousArtifactReference: null,
          content: c.content,
          createdAt: at,
          updatedAt: at,
          dataClassification: "Internal",
        });
        const auditReference = o.references.nextReference("Audit"),
          intentDigest = hash(c);
        await o.appendAudit(o.transaction, {
          ...scope4,
          artifactKind: c.artifactKind,
          operationReference: c.operationReference,
          auditReference,
          intentDigest,
          purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
          mode: "Save",
          occurredAt: at,
        });
        active = false;
        return parseDigitalReceiptTemplateArtifactReceipt({
          profile: "DigitalReceiptTemplateArtifactReceiptV1",
          ...scope4,
          artifactKind: c.artifactKind,
          operationReference: c.operationReference,
          expectedArtifactReference: c.expectedArtifactReference,
          expectedRevision: c.expectedRevision,
          intentDigest,
          outcome: "Committed",
          snapshot,
          auditReference,
          occurredAt: at,
        });
      },
      async resolve(c: DigitalReceiptTemplateArtifactResolve) {
        command = c;
        mode = "Resolve";
        await enter();
        const auditReference = o.references.nextReference("Audit");
        await o.appendAudit(o.transaction, {
          ...scope4,
          artifactKind: c.artifactKind,
          operationReference: c.operationReference,
          auditReference,
          intentDigest: c.intentDigest,
          purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
          mode: "Abandon",
          occurredAt: at,
        });
        active = false;
        return parseDigitalReceiptTemplateArtifactReceipt({
          profile: "DigitalReceiptTemplateArtifactReceiptV1",
          ...scope4,
          artifactKind: c.artifactKind,
          operationReference: c.operationReference,
          expectedArtifactReference: c.expectedArtifactReference,
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
  // encrypted Session/IAM, native Device persistence or independent Audit proof.
  const service = createMerchantReceiptTemplateArtifacts(
    options as unknown as Parameters<typeof createMerchantReceiptTemplateArtifacts>[0],
  );
  return { service, state, scope, editingScope, events, handles, options, authenticate, query };
}
const write = (
  f: ReturnType<typeof fixture>,
  artifactKind: DigitalReceiptTemplateArtifactKind = "Layout",
) =>
  f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    artifactKind,
    command: body(artifactKind),
  });
const read = (f: ReturnType<typeof fixture>) =>
  f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3) });
it("reads current software artifacts using only actual organization scope, without edit permission or allocation", async () => {
  const f = fixture();
  f.state.integrationDenied = true;
  const result = await read(f);
  expect(result).toMatchObject({
    profile: "DigitalReceiptTemplateArtifactsCurrentV1",
    ...scope4,
    layout: null,
    compliance: null,
    sourceQualification: "NotEvaluated",
  });
  expect(mocks.scope).toHaveBeenCalledTimes(1);
  expect(mocks.scope.mock.calls[0]?.[2]).toBe("organization.manage");
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(f.events.slice(-2)).toEqual(["commit", "finalized"]);
});
it.each(["Layout", "Compliance"] as const)(
  "saves %s after both genuine scoped acquisitions, with sameTX intent-only Audit",
  async (artifactKind) => {
    const f = fixture(),
      result = await write(f, artifactKind);
    expect(mocks.scope.mock.calls.map((call) => call[2])).toEqual([
      "organization.manage",
      "integration.manage",
    ]);
    expect(result).toMatchObject({
      outcome: "Committed",
      artifactKind,
      snapshot: {
        artifactKind,
        revision: 1,
        authoredByReference: scope4.actorReference,
        content: artifactKind === "Layout" ? layout : compliance,
      },
    });
    expect(result.intentDigest).toBe(
      hash({
        profile: "DigitalReceiptTemplateArtifactSaveV1",
        ...scope4,
        artifactKind,
        operationReference: id(8),
        expectedArtifactReference: null,
        expectedRevision: 0,
        content: artifactKind === "Layout" ? layout : compliance,
        purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
      }),
    );
    const audit = mocks.audit.mock.calls[0]?.[1];
    expect(audit).toBeDefined();
    expect(audit.afterSummary).toEqual({ intentDigest: result.intentDigest });
    expect(audit.targetType).toBe("DigitalReceiptTemplateArtifact");
    expect(audit.actor).toEqual({ type: "User", reference: scope4.actorReference });
    expect(audit.actionCode).toBe("RECEIPT_TEMPLATE_ARTIFACT_SAVED");
    expect(audit).not.toHaveProperty("content");
    expect(audit).not.toHaveProperty("professionalReviewStatus");
    expect(mocks.audit.mock.calls[0]?.[0]).toBe(f.handles.owner?.transaction);
    expect(f.events.indexOf("csrf")).toBeLessThan(f.events.indexOf("begin"));
    expect(f.events.indexOf("owner final")).toBeLessThan(f.events.indexOf("commit"));
  },
);
it.each(["SaveArtifact", "ResolveOriginal"] as const)(
  "missing integration edit grant denies %s before owner allocation",
  async (command) => {
    const f = fixture();
    f.state.integrationDenied = true;
    await expect(
      f.service.write({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        expectedScope: scope4,
        artifactKind: "Layout",
        command:
          command === "SaveArtifact"
            ? body()
            : {
                command,
                operationReference: id(8),
                expectedArtifactReference: null,
                expectedRevision: 0,
                intentDigest: "sha256:" + "a".repeat(64),
              },
      }),
    ).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_PERMISSION_DENIED");
    expect(mocks.scope.mock.calls.map((call) => call[2])).toEqual([
      "organization.manage",
      "integration.manage",
    ]);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(f.options.nextReference).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(f.events).not.toContain("commit");
  },
);
it("resolves original pins/digest with both permissions and no supplied software content", async () => {
  const f = fixture(),
    intentDigest = "sha256:" + "a".repeat(64);
  const result = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    artifactKind: "Compliance",
    command: {
      command: "ResolveOriginal",
      operationReference: id(8),
      expectedArtifactReference: id(60),
      expectedRevision: 3,
      intentDigest,
    },
  });
  expect(result).toMatchObject({
    outcome: "Abandoned",
    artifactKind: "Compliance",
    snapshot: null,
    expectedArtifactReference: id(60),
    expectedRevision: 3,
    intentDigest,
  });
  expect(mocks.scope.mock.calls.map((call) => call[2])).toEqual([
    "organization.manage",
    "integration.manage",
  ]);
  expect(mocks.audit.mock.calls[0]?.[1].actionCode).toBe(
    "RECEIPT_TEMPLATE_ARTIFACT_ORIGINAL_ABANDONED",
  );
  expect(mocks.audit.mock.calls[0]?.[1].afterSummary).toEqual({ intentDigest });
  expect(f.options.nextReference).toHaveBeenCalledTimes(1);
});
it("retains the historical writer separately from current reader", async () => {
  const f = fixture();
  f.state.historical = true;
  const result = await read(f);
  expect(result.actorReference).toBe(id(4));
  expect(result.layout?.authoredByReference).toBe(id(88));
});
it.each(["tenantReference", "brandReference", "storeReference", "actorReference"] as const)(
  "refuses expected %s substitution before owner or allocation",
  async (key) => {
    const f = fixture();
    await expect(
      f.service.write({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        expectedScope: { ...scope4, [key]: id(99) },
        artifactKind: "Layout",
        command: body(),
      }),
    ).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_PERMISSION_DENIED");
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(f.options.nextReference).not.toHaveBeenCalled();
  },
);
it("refuses when separate edit acquisition returns another actual Actor or Store", async () => {
  const f = fixture();
  f.editingScope.actorReference = id(99);
  await expect(write(f)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(mocks.owner).not.toHaveBeenCalled();
  const g = fixture();
  g.editingScope.store.storeReference = id(99);
  await expect(write(g)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(g.options.nextReference).not.toHaveBeenCalled();
});
it("denies a different selected Store current read", async () => {
  const f = fixture();
  await expect(
    f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(99) }),
  ).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(mocks.owner).not.toHaveBeenCalled();
});
it("rejects route-kind/body mismatch before authentication", async () => {
  const f = fixture();
  await expect(
    f.service.write({
      sessionCookie: "synthetic",
      csrf: "synthetic",
      expectedScope: scope4,
      artifactKind: "Compliance",
      command: body(),
    }),
  ).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_INPUT_INVALID");
  expect(f.authenticate).not.toHaveBeenCalled();
});
it("rejects invalid owner kind packet without COMMIT", async () => {
  const f = fixture();
  f.state.wrongKind = true;
  await expect(write(f)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("denied CSRF never enters the transaction", async () => {
  const f = fixture();
  f.authenticate.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  await expect(write(f)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.events).not.toContain("begin");
});
it.each(["organization", "integration"] as const)(
  "late %s withdrawal after Audit rejects final commit",
  async (action) => {
    const f = fixture();
    mocks.audit.mockImplementationOnce(async (_tx, audit) => {
      validateAuditRecord(audit, Date.parse(at));
      if (action === "organization") f.state.allowed = false;
      else f.state.editingAllowed = false;
    });
    await expect(write(f)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_PERMISSION_DENIED");
    expect(f.events).toContain("owner guard");
    expect(f.events).toContain("rollback");
    expect(f.events).not.toContain("commit");
  },
);
it.each(["organization", "integration"] as const)(
  "both acquisitions constrain initial owner lease: shorter %s",
  async (action) => {
    const f = fixture(),
      short = new Date(Date.parse(at) + 1000).toISOString();
    if (action === "organization") f.state.until = short;
    else f.state.editingUntil = short;
    await write(f);
    expect(f.handles.owner?.originalValidUntil).toBe(short);
  },
);
it("late organization lease tightens the final public current packet", async () => {
  const f = fixture();
  f.state.shorten = true;
  const result = await read(f);
  expect(result.validUntil).toBe(new Date(Date.parse(at) + 1000).toISOString());
});
it("expired original authority prevents final COMMIT", async () => {
  const f = fixture();
  f.state.expire = true;
  await expect(write(f)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("missing own final assertion never yields successful current read", async () => {
  const f = fixture();
  f.state.dropFinal = true;
  await expect(read(f)).rejects.toThrow();
});
it("detaches canonical field arrays and CAS pins before async authentication", async () => {
  const f = fixture(),
    command = { ...body(), content: { ...layout, requiredFields: [...layout.requiredFields] } };
  f.authenticate.mockImplementationOnce(async () => {
    command.content.requiredFields.reverse();
    command.expectedRevision = 9;
    return { sessionReference: id(5) };
  });
  const result = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    artifactKind: "Layout",
    command,
  });
  expect(result).toMatchObject({ expectedRevision: 0, snapshot: { content: layout } });
});
it("rejects captured allocation/clock drift before acquisition", async () => {
  const f = fixture();
  f.options.nextReference = vi.fn(() => id(99));
  await expect(read(f)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.events).toEqual([]);
  const g = fixture();
  g.options.persistence.now = () => at;
  await expect(read(g)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(g.events).toEqual([]);
});
it("rejects edit scope authority port replacement after Audit", async () => {
  const f = fixture();
  mocks.audit.mockImplementationOnce(async (_tx, audit) => {
    validateAuditRecord(audit, Date.parse(at));
    f.editingScope.allowed = vi.fn(async () => true);
  });
  await expect(write(f)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(f.events).not.toContain("commit");
});
it("Audit transport failure rolls back and remains bounded without private cause", async () => {
  const f = fixture();
  f.state.auditFailure = true;
  await expect(write(f)).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("unknown authentication failure is unavailable rather than permission granted", async () => {
  const f = fixture();
  f.authenticate.mockRejectedValueOnce(new Error("Synthetic private failure"));
  await expect(write(f)).rejects.toHaveProperty("code", "RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.events).not.toContain("begin");
});
