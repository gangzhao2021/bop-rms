import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  BrowserSessionError,
  createAuthenticationSession,
  createIdentityActor,
  parseSelectorHash,
} from "@bop/identity";
import {
  BrandConfigurationOperationError,
  createBrand,
  createBrandConfigurationVersion,
  createBrandConfigurationRevision,
  parseBrandConfigurationCommand,
  parseBrandConfigurationReceipt,
  createBrandAdministrationContext,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  tenantBrandConfigurationContentDigest,
  brandConfigurationOperationRequiredFields,
  type BrandConfigurationAuthoringStoreOptions,
} from "@bop/tenant";
import {
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  type PlatformTemplateBrandReferenceSourceOptions,
  type PlatformTemplateBrandReferenceList,
} from "@bop/publishing";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  createMerchantBrandConfigurationOrdinary,
  type MerchantBrandConfigurationOrdinaryOptions,
} from "./merchant-brand-configuration-ordinary.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  owner: vi.fn(),
  capability: vi.fn(),
  preparation: vi.fn(),
  templates: vi.fn(),
}));
vi.mock("@bop/publishing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bop/publishing")>();
  return { ...actual, createPostgresPlatformTemplateBrandReferenceSource: mocks.templates };
});
vi.mock("./merchant-current-brand-scope.js", () => ({
  createMerchantCurrentBrandAdministrationScope: () => mocks.scope,
}));
vi.mock("./merchant-brand-administration-capability.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./merchant-brand-administration-capability.js")>();
  return { ...actual, createMerchantCurrentBrandAdministrationCapability: mocks.capability };
});
vi.mock("./merchant-brand-configuration-preparation.js", () => ({
  createMerchantBrandAdministrationConfigurationPreparation: mocks.preparation,
}));
vi.mock("@bop/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bop/tenant")>();
  return { ...actual, createPostgresBrandConfigurationAuthoringStore: mocks.owner };
});
const id = (n: number) => `01902606-2421-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
const fields = () => ({
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA"],
  mediaThemeReference: null,
  catalogSourceReference: id(4),
  platformTemplateReference: id(5),
  overrideAllowedFieldCodes: [],
  hardRequirementFieldCodes: [],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "INITIAL_CONFIGURATION",
});
const command = () => ({
  command: "SaveConfigurationDraft",
  operationReference: id(10),
  expectedBrandVersion: 1,
  expectedHead: null,
  configuration: fields(),
  reviewValidUntil: null,
});
beforeEach(() => vi.resetAllMocks());
/** Controlled public Session/scope/Feature/Tenant/preparation boundaries. Real
 * transport parsers, transaction host and Audit writer run. This does not prove
 * encrypted Session, SQL authoring, Core publication or native reference holders. */
function fixture() {
  const actor = createIdentityActor({
      actorType: "User",
      actorReference: id(3),
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    }),
    brand = createBrand({
      brandReference: id(2),
      code: "BRAND",
      displayName: "Controlled Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Draft",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    session = createAuthenticationSession({
      sessionReference: id(6),
      actor,
      status: "Active",
      policyCode: "WorkforceStandard",
      maxActiveSessions: 5,
      idleTimeoutMinutes: 30,
      absoluteTimeoutMinutes: 720,
      version: 1,
      authenticatedAt: at,
      createdAt: at,
      lastSeenAt: at,
      idleExpiresAt: "2026-10-06T10:30:00.000Z",
      absoluteExpiresAt: "2026-10-06T22:00:00.000Z",
      rotatedFromSessionReference: null,
      revocationReason: null,
      revokedAt: null,
    });
  const scope = { tenantReference: id(2), brandReference: id(2), actorReference: id(3) };
  const state = {
    clock: at,
    allowed: true,
    feature: true,
    commits: 0,
    replay: true,
    afterCommitExpiry: false,
  };
  const events: string[] = [];
  const permission = vi.fn(async (actions: readonly string[]) => ({
    context: createBrandAdministrationContext(actor, brand, state.clock),
    decisions: actions.map((action) => ({
      effect: state.allowed ? ("Allow" as const) : ("Deny" as const),
      reason: state.allowed ? ("ROLE_PERMISSION" as const) : ("DEFAULT_DENY" as const),
      source: state.allowed ? ("RolePermission" as const) : ("DefaultDeny" as const),
      action: parseBusinessAction(action),
      scopeKind: "Brand" as const,
      policySnapshotReference: parsePolicyReference(id(20)),
      policyVersion: parsePolicyVersion(1),
      audit: {
        effect: state.allowed ? ("Allow" as const) : ("Deny" as const),
        reason: state.allowed ? ("ROLE_PERMISSION" as const) : ("DEFAULT_DENY" as const),
        source: state.allowed ? ("RolePermission" as const) : ("DefaultDeny" as const),
      },
    })),
    validUntil: until,
  }));
  const current = {
    tenantReference: scope.tenantReference,
    actorReference: actor.actorReference,
    context: createBrandAdministrationContext(actor, brand, at),
    sessionReference: session.sessionReference,
    authorizeActionsWithValidity: permission,
    assertCurrent() {
      if (state.clock >= until) throw new Error("controlled expired authority");
    },
  };
  mocks.scope.mockResolvedValue(current);
  const auditValues: (readonly unknown[])[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    events.push(sql);
    if (sql.startsWith("INSERT INTO platform_audit.audit_record")) auditValues.push([...values]);
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: state.clock }] };
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: "2" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const tx = { query };
  let owning: BrandConfigurationAuthoringStoreOptions | undefined;
  const original = parseBrandConfigurationCommand({
    ...command(),
    ...scope,
    profile: "TenantBrandConfigurationCommandV1",
    purposeCode: "BRAND_CONFIGURATION",
  });
  const configuration = createBrandConfigurationVersion({
    ...fields(),
    configurationVersionReference: id(30),
    brandReference: scope.brandReference,
    configurationVersion: 1,
    lifecycle: "Draft",
    supersedesVersionReference: null,
    authoredByReference: scope.actorReference,
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  const revision = createBrandConfigurationRevision(
    {
      profile: "TenantBrandConfigurationRevisionV1",
      ...scope,
      revision: 1,
      brandVersion: 1,
      command: original.command,
      operationReference: original.operationReference,
      configuration,
      submittedByReference: null,
      publishing: null,
      auditReference: id(31),
      createdAt: at,
      recordedAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    { canonicalize: canonicalizeRfc8785, hashIntent: (text) => "sha256:" + sha256Hex(text) },
  );
  const receipt = parseBrandConfigurationReceipt({
    profile: "TenantBrandConfigurationOperationV1",
    ...scope,
    command: original.command,
    operationReference: original.operationReference,
    expectedBrandVersion: 1,
    expectedHead: null,
    purposeCode: "BRAND_CONFIGURATION",
    intentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(original)),
    originalCommand: original,
    outcome: "Committed",
    snapshot: revision,
    auditReference: id(31),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  const currentPacket = parseBrandConfigurationCurrent({
    profile: "TenantBrandConfigurationCurrentV1",
    ...scope,
    current: null,
    observedAt: at,
    validUntil: until,
    currentPublication: "NotEvaluated",
  });
  const historyPacket = parseBrandConfigurationHistory({
    profile: "TenantBrandConfigurationHistoryV1",
    ...scope,
    beforeRevision: null,
    entries: [],
    nextBeforeRevision: null,
    observedAt: at,
    validUntil: until,
    currentPublication: "NotEvaluated",
  });
  mocks.capability.mockImplementation((options) => ({
    async holdUntilCommit() {
      events.push("feature");
      if (!state.feature)
        throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
      await options.registerBeforeCommit(
        options.transaction,
        async () => {
          if (!state.feature) throw new Error("controlled withdrawal");
        },
        () => undefined,
      );
    },
    assertFinalized() {
      events.push("feature-finalized");
    },
  }));
  mocks.owner.mockImplementation((options: BrandConfigurationAuthoringStoreOptions) => {
    owning = options;
    const admit = async () =>
      options.registerBeforeCommit(
        options.transaction,
        async () => undefined,
        () => undefined,
      );
    return {
      async readCurrent() {
        await admit();
        return currentPacket;
      },
      async readHistory() {
        await admit();
        return historyPacket;
      },
      async execute(value: unknown) {
        await admit();
        events.push("original-arbitrated");
        if (!state.replay) {
          await options.prepareFresh(options.transaction, {
            command: parseBrandConfigurationCommand(value),
            current: null,
            configuration,
            observedAt: at,
            validUntil: until,
          });
        }
        return receipt;
      },
      async resolve() {
        await admit();
        return receipt;
      },
      assertFinalized() {
        events.push("owner-finalized");
      },
    };
  });
  const configure = vi.fn(
    (
      actual: Parameters<MerchantBrandConfigurationOrdinaryOptions["configure"]>[0],
      configuredScope: Parameters<MerchantBrandConfigurationOrdinaryOptions["configure"]>[1],
      sourceHost: Parameters<MerchantBrandConfigurationOrdinaryOptions["configure"]>[2],
    ) => {
      expect(typeof actual.query).toBe("function");
      expect(configuredScope).toEqual(scope);
      expect(typeof sourceHost.registerBeforeCommit).toBe("function");
      return {
        references: {
          async withCurrentReferences() {
            throw new Error("controlled required reference unavailable");
          },
        },
      };
    },
  );
  const authenticate = vi.fn(async () => session),
    next = vi.fn(() => id(99));
  const options: MerchantBrandConfigurationOrdinaryOptions = {
    persistence: {
      identity: {
        hasher: { hash: () => parseSelectorHash("a".repeat(64)), equals: (a, b) => a === b },
        envelopes: {
          async encrypt() {
            throw new Error("controlled scope bypasses encryption");
          },
          async decrypt() {
            throw new Error("controlled scope bypasses encryption");
          },
        },
        configuration: {
          environment: "controlled",
          issuer: "https://identity.example.test/",
          clientId: "controlled",
          redirectUri: "https://merchant.example.test/merchant/organization/brands/callback",
          allowedPostLoginPaths: [`/app/organization/brands/${id(2)}`],
        },
      },
      currentActor: async () => actor,
      now: () => state.clock,
      transactions: {
        async run(work) {
          const result = await work(tx);
          state.commits++;
          if (state.afterCommitExpiry) state.clock = until;
          return result;
        },
      },
    },
    authentication: { authorize: authenticate },
    nextReference: next,
    configure,
  };
  const ordinary = createMerchantBrandConfigurationOrdinary(options),
    input = {
      sessionCookie: "controlled-cookie",
      csrf: "controlled-csrf",
      expectedBrandReference: scope.brandReference,
    };
  return {
    ordinary,
    input,
    state,
    events,
    current,
    permission,
    options,
    authenticate,
    configure,
    next,
    receipt,
    currentPacket,
    historyPacket,
    owning: () => owning,
    tx,
    session,
    auditValues,
  };
}
function templateFixture() {
  const f = fixture();
  const control = {
    hasMore: false,
    deadline: until,
    denyAtGuard: false,
    expireAtGuard: false,
    unavailable: false,
  };
  const list = vi.fn();
  mocks.templates.mockImplementation((options: PlatformTemplateBrandReferenceSourceOptions) => {
    expect(options.transaction).not.toBe(f.tx);
    expect(typeof options.transaction.query).toBe("function");
    expect(options.scope).toEqual({
      tenantReference: id(2),
      brandReference: id(2),
      actorReference: id(3),
    });
    let ready = false,
      sealed = false;
    const hold = async () => {
      const observedAt = options.clock.now();
      return options.authority.holdUntilTransactionCompletes(options.transaction, {
        scope: options.scope,
        permission: "organization.manage",
        purposeCode: "BRAND_ADMINISTRATION",
        observedAt,
        validUntil: control.deadline,
      });
    };
    list.mockImplementation(
      async (input: { afterTemplateReference: string | null; limit: number }) => {
        expect(input.limit).toBe(20);
        await options.registerBeforeCommit(
          options.transaction,
          async () => {
            if (control.denyAtGuard) f.state.allowed = false;
            if (control.expireAtGuard) f.state.clock = control.deadline;
            await hold();
            ready = true;
          },
          () => {
            options.clock.now();
            if (!ready) throw new Error("controlled source was not checked");
            sealed = true;
          },
        );
        await hold();
        if (control.unavailable) throw new Error("controlled owning source unavailable");
        const packet: PlatformTemplateBrandReferenceList = {
          profile: "PlatformTemplateBrandReferenceListV1",
          scope: options.scope,
          // Empty candidates here represent the controlled public-source boundary;
          // actual Published content is separately proven by owning native tests.
          items: [],
          hasMore: control.hasMore,
          nextAfterTemplateReference: control.hasMore ? id(90) : null,
          observedAt: at,
          validUntil: control.deadline,
        };
        return packet;
      },
    );
    return {
      list,
      assertFinalized() {
        if (!sealed) throw new Error("controlled source not finalized");
        f.events.push("template-finalized");
      },
    };
  });
  return { ...f, control, list };
}
it.each([null, id(80)])(
  "reads scoped bounded Template candidates after real host seals for cursor %s without creating an authoring owner",
  async (afterTemplateReference) => {
    const f = templateFixture();
    f.control.hasMore = true;
    f.state.afterCommitExpiry = true;
    const response = await f.ordinary.templates({ ...f.input, afterTemplateReference });
    expect(response).toMatchObject({
      profile: "MerchantBrandTemplateCandidatesV1",
      tenantReference: id(2),
      brandReference: id(2),
      actorReference: id(3),
      afterTemplateReference,
      items: [],
      hasMore: true,
      nextAfterTemplateReference: id(90),
    });
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ afterTemplateReference, limit: 20 });
    expect(f.state.commits).toBe(1);
    expect(f.events.slice(-2)).toEqual(["feature-finalized", "template-finalized"]);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
    expect(f.auditValues).toEqual([]);
    expect(f.tx.query).not.toHaveBeenCalled();
  },
);
it.each(["denial", "expiry", "unavailable"])(
  "rolls back Template candidate reads on owning %s without configuration writes",
  async (kind) => {
    const f = templateFixture();
    f.control.deadline = "2026-10-06T10:00:02.000Z";
    f.control.denyAtGuard = kind === "denial";
    f.control.expireAtGuard = kind === "expiry";
    f.control.unavailable = kind === "unavailable";
    await expect(
      f.ordinary.templates({ ...f.input, afterTemplateReference: null }),
    ).rejects.toMatchObject({
      code:
        kind === "denial"
          ? "BRAND_CONFIGURATION_PERMISSION_DENIED"
          : "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.state.commits).toBe(0);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.auditValues).toEqual([]);
  },
);
it.each([
  { afterTemplateReference: "foreign" },
  { afterTemplateReference: null, limit: 20 },
  { afterTemplateReference: null, actorReference: id(3) },
])(
  "refuses invalid or browser authority Template input before authentication %j",
  async (patch) => {
    const f = templateFixture();
    await expect(f.ordinary.templates({ ...f.input, ...patch })).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_INPUT_INVALID",
    });
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(mocks.templates).not.toHaveBeenCalled();
  },
);
it("returns exact owning current/history packets after true host seals", async () => {
  const f = fixture();
  expect(await f.ordinary.current(f.input)).toEqual({ ...f.currentPacket, recordedReview: null });
  expect(await f.ordinary.history({ ...f.input, beforeRevision: null })).toBe(f.historyPacket);
  expect(f.state.commits).toBe(2);
  expect(f.configure).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
});
for (const drift of [false, true])
  it(`composes actual public Publishing review and refuses final drift=${drift}`, async () => {
    const f = fixture(),
      draft = f.receipt.snapshot;
    if (!draft) throw new Error("controlled missing Draft");
    const digest = tenantBrandConfigurationContentDigest(draft.configuration),
      publishingScope = { kind: "Brand", brandReference: id(2), storeReference: null },
      life = {
        lifecycleId: id(70),
        familyReference: id(2),
        configurationType: "BRAND_CONFIGURATION",
        purposeCode: "BRAND_CONFIGURATION",
        snapshotReference: draft.configuration.configurationVersionReference,
        snapshotDigest: digest,
        scope: publishingScope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: at,
        changedAt: at,
      };
    const mutation = parseRecordedPublishingMutation({
      operation: "SubmitReview",
      expectedVersion: 1,
      idempotencyKey: id(71),
      current: life,
      next: { ...life, state: "InReview", version: 2, validationEvidenceReference: id(72) },
      validationEvidence: {
        evidenceReference: id(72),
        snapshotReference: life.snapshotReference,
        snapshotDigest: digest,
        scope: publishingScope,
        result: "Pass",
        checkedAt: at,
        validUntil: "2026-10-06T11:00:00.000Z",
        checkCodes: ["CURRENT_REFERENCES"],
      },
      approvalEvidence: null,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      audit: {
        auditId: id(73),
        brandId: id(2),
        actor: { type: "User", reference: id(3) },
        actionCode: "PUBLISHING_REVIEW_SUBMITTED",
        targetType: "PublishingLifecycle",
        targetId: id(70),
        reasonCode: "AUTHORIZED_OPERATION",
        correlationId: id(71),
        occurredAt: at,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "AUDIT_SECURITY",
        retentionPolicyVersion: 1,
      },
    });
    const revision = createBrandConfigurationRevision(
      {
        ...Object.fromEntries(
          Object.entries(draft).filter(
            ([key]) => key !== "contentDigest" && key !== "sourceDigest",
          ),
        ),
        revision: 2,
        command: "SubmitConfiguration",
        operationReference: id(71),
        configuration: { ...draft.configuration, lifecycle: "PendingApproval" },
        submittedByReference: id(3),
        publishing: {
          familyReference: id(2),
          lifecycleReference: id(70),
          lifecycleVersion: 2,
          mutationOperationReference: id(71),
          validationEvidenceReference: id(72),
          approvalEvidenceReference: null,
          publicationReference: null,
        },
        auditReference: id(74),
      },
      { canonicalize: canonicalizeRfc8785, hashIntent: (v) => "sha256:" + sha256Hex(v) },
    );
    const current = parseBrandConfigurationCurrent({ ...f.currentPacket, current: revision });
    mocks.owner.mockImplementation((options: BrandConfigurationAuthoringStoreOptions) => ({
      async readCurrent() {
        await options.authority.holdUntilTransactionCompletes(options.transaction, {
          tenantReference: current.tenantReference,
          brandReference: current.brandReference,
          actorReference: current.actorReference,
          permission: "organization.manage",
          purposeCode: "BRAND_CONFIGURATION",
          mode: "Read",
          command: null,
          requiredFields: brandConfigurationOperationRequiredFields,
          observedAt: at,
          validUntil: until,
        });
        return current;
      },
      assertFinalized: vi.fn(),
    }));
    const originalQuery = f.tx.query.getMockImplementation();
    let headReads = 0;
    f.tx.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith("SELECT mutation_json")) {
        if (!sql.includes("audit_id")) headReads++;
        const currentMutation =
          drift && headReads >= 2
            ? parseRecordedPublishingMutation({ ...mutation, idempotencyKey: id(99) })
            : mutation;
        return {
          rows: [
            {
              mutation_json: currentMutation,
              intent_hash: publishingRecordedMutationDigest(currentMutation),
              audit_id: currentMutation.audit.auditId,
            },
          ],
          rowCount: 1,
        };
      }
      if (!originalQuery) throw new Error("controlled missing query");
      return originalQuery(sql, values);
    });
    if (drift) {
      await expect(f.ordinary.current(f.input)).rejects.toMatchObject({
        code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
      });
      expect(f.state.commits).toBe(0);
      expect(f.configure).not.toHaveBeenCalled();
      expect(f.next).not.toHaveBeenCalled();
      return;
    }
    const response = await f.ordinary.current(f.input);
    expect(response).toMatchObject({
      recordedReview: {
        submittedByReference: id(3),
        submittedAt: at,
        reviewValidUntil: "2026-10-06T11:00:00.000Z",
        configurationSourceDigest: revision.sourceDigest,
      },
    });
    expect(
      f.tx.query.mock.calls.filter(([sql]) => sql.startsWith("SELECT mutation_json")),
    ).toHaveLength(4);
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
    expect(f.state.commits).toBe(1);
  });
it("derives identities and refuses hidden scope, Actor, qualification and report fields", async () => {
  for (const addition of [
    { actorReference: id(77) },
    { tenantReference: id(77) },
    { qualification: true },
    { report: {} },
    { approvalEvidenceReference: id(77) },
  ]) {
    const f = fixture();
    await expect(
      f.ordinary.execute({ ...f.input, command: { ...command(), ...addition } }),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_INPUT_INVALID" });
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(mocks.owner).not.toHaveBeenCalled();
  }
  const f = fixture();
  await expect(
    f.ordinary.current({ ...f.input, expectedBrandReference: id(77) }),
  ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_PERMISSION_DENIED" });
  expect(mocks.owner).not.toHaveBeenCalled();
});
it("returns retained originals from Execute and Resolve without fresh references or allocation", async () => {
  const f = fixture();
  expect(await f.ordinary.execute({ ...f.input, command: command() })).toBe(f.receipt);
  expect(
    await f.ordinary.resolve({
      ...f.input,
      original: {
        command: "SaveConfigurationDraft",
        operationReference: id(10),
        expectedBrandVersion: 1,
        expectedHead: null,
        intentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(command())),
      },
    }),
  ).toBe(f.receipt);
  expect(f.configure).not.toHaveBeenCalled();
  expect(mocks.preparation).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
});
it("calls required preparation only after original arbitration and passes same transaction", async () => {
  const f = fixture();
  f.state.replay = false;
  mocks.preparation.mockImplementation(
    (options) =>
      async (actual: Parameters<MerchantBrandConfigurationOrdinaryOptions["configure"]>[0]) => {
        expect(actual).toBe(options.transaction);
        expect(actual).toBe(f.configure.mock.calls[0]?.[0]);
        expect(options.references).toBeDefined();
        throw new Error("controlled source unavailable");
      },
  );
  await expect(f.ordinary.execute({ ...f.input, command: command() })).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.configure).toHaveBeenCalledOnce();
  expect(f.events).toContain("original-arbitrated");
  expect(f.state.commits).toBe(0);
});
it("maps genuine Session and scope refusal to bounded permission denial", async () => {
  for (const boundary of ["Session", "Scope"]) {
    const f = fixture();
    if (boundary === "Session")
      f.authenticate.mockRejectedValue(new BrowserSessionError("BROWSER_SESSION_DENIED"));
    else mocks.scope.mockRejectedValue(new Error("BRAND_SERVICE_PERMISSION_DENIED"));
    await expect(f.ordinary.current(f.input)).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
    });
    expect(f.state.commits).toBe(0);
    expect(mocks.owner).not.toHaveBeenCalled();
  }
});
it("rejects current permission withdrawal and Feature refusal before owner effects", async () => {
  const f = fixture();
  f.state.allowed = false;
  await expect(f.ordinary.current(f.input)).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  expect(mocks.owner).not.toHaveBeenCalled();
  const g = fixture();
  g.state.feature = false;
  await expect(g.ordinary.current(g.input)).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(mocks.owner).not.toHaveBeenCalled();
});
it("seals original lease after a later asynchronous guard and does not commit", async () => {
  const f = fixture();
  mocks.owner.mockImplementation((options) => ({
    async readCurrent() {
      await options.registerBeforeCommit(
        options.transaction,
        async () => {
          f.state.clock = until;
        },
        () => undefined,
      );
      return f.currentPacket;
    },
    assertFinalized: vi.fn(),
  }));
  await expect(f.ordinary.current(f.input)).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.commits).toBe(0);
  expect(f.events).not.toContain("owner-finalized");
});
it("refuses captured authentication port drift without source effects", async () => {
  const f = fixture();
  f.options.authentication.authorize = async () => {
    throw new Error("untrusted replacement");
  };
  await expect(f.ordinary.current(f.input)).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(mocks.owner).not.toHaveBeenCalled();
});
it("does not expose unknown credential/source error messages", async () => {
  const f = fixture();
  f.authenticate.mockRejectedValue(new Error("controlled-secret-value"));
  await expect(f.ordinary.current(f.input)).rejects.toMatchObject({
    message: "Brand configuration operation is unavailable",
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
});

it("keeps true post-COMMIT finalization pure after the lease expires", async () => {
  const f = fixture();
  f.state.afterCommitExpiry = true;
  expect(await f.ordinary.current(f.input)).toEqual({ ...f.currentPacket, recordedReview: null });
  expect(f.state.commits).toBe(1);
  expect(f.events).toContain("owner-finalized");
});
it("writes bounded actual public Audit with the selected Brand and no Store", async () => {
  const f = fixture();
  mocks.owner.mockImplementation((options: BrandConfigurationAuthoringStoreOptions) => ({
    async readCurrent() {
      await options.registerBeforeCommit(
        options.transaction,
        async () => undefined,
        () => undefined,
      );
      await options.appendAudit(options.transaction, {
        tenantReference: id(2),
        brandReference: id(2),
        actorReference: id(3),
        commandName: "SaveConfigurationDraft",
        operationReference: id(10),
        intentDigest: "sha256:" + "a".repeat(64),
        configurationVersionReference: null,
        auditReference: id(31),
        occurredAt: at,
        purposeCode: "BRAND_CONFIGURATION",
        mode: "Abandon",
      });
      return f.currentPacket;
    },
    assertFinalized: vi.fn(),
  }));
  expect(await f.ordinary.current(f.input)).toEqual({ ...f.currentPacket, recordedReview: null });
  expect(
    f.tx.query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO platform_audit.audit_record"),
    ),
  ).toBe(true);
  expect(f.auditValues).toHaveLength(1);
  expect(f.auditValues[0]?.[1]).toBe(id(2));
  expect(f.auditValues[0]?.[2]).toBeNull();
  expect(f.auditValues[0]?.[4]).toBe(id(3));
});

it("captures nested editable values before authentication awaits and refuses getters", async () => {
  const f = fixture(),
    body = command();
  f.authenticate.mockImplementation(async () => {
    body.configuration.defaultLocale = "fr-CA";
    return f.session;
  });
  mocks.owner.mockImplementation((options: BrandConfigurationAuthoringStoreOptions) => ({
    async execute(value: unknown) {
      await options.registerBeforeCommit(
        options.transaction,
        async () => undefined,
        () => undefined,
      );
      expect(parseBrandConfigurationCommand(value).configuration?.defaultLocale).toBe("en-CA");
      return f.receipt;
    },
    assertFinalized: vi.fn(),
  }));
  expect(await f.ordinary.execute({ ...f.input, command: body })).toBe(f.receipt);
  const g = fixture(),
    bad = command(),
    getter = vi.fn(() => true);
  Object.defineProperty(bad.configuration, "hiddenQualification", {
    enumerable: true,
    get: getter,
  });
  await expect(g.ordinary.execute({ ...g.input, command: bad })).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_INPUT_INVALID",
  });
  expect(getter).not.toHaveBeenCalled();
  expect(g.authenticate).not.toHaveBeenCalled();
});

it("maps a genuine current-scope refusal in the async preCOMMIT guard before host wrapping", async () => {
  const f = fixture(),
    original = f.permission.getMockImplementation();
  let calls = 0;
  f.permission.mockImplementation(async (actions) => {
    if (++calls === 2) throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
    if (!original) throw new Error("controlled missing boundary");
    return original(actions);
  });
  await expect(f.ordinary.current(f.input)).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_PERMISSION_DENIED",
  });
  expect(f.state.commits).toBe(0);
  expect(f.events).not.toContain("owner-finalized");
});

it("rejects a holder registering the underlying transaction instead of the actual host transaction", async () => {
  const f = fixture();
  mocks.capability.mockImplementation((options) => ({
    async holdUntilCommit() {
      expect(options.transaction).not.toBe(f.tx);
      await options.registerBeforeCommit(
        f.tx,
        async () => undefined,
        () => undefined,
      );
    },
    assertFinalized: vi.fn(),
  }));
  await expect(f.ordinary.current(f.input)).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.commits).toBe(0);
  expect(mocks.owner).not.toHaveBeenCalled();
});

it("rejects asynchronous/nonvoid post-COMMIT source assertions and absorbs rejections", async () => {
  for (const kind of ["Promise", "NonVoid", "SQL"]) {
    const f = fixture();
    f.state.replay = false;
    const original = f.configure.getMockImplementation();
    f.configure.mockImplementation((actual, scope, sourceHost) => {
      if (!original) throw new Error("controlled missing configure");
      sourceHost.registerAfterCommit(actual, () =>
        kind === "Promise"
          ? Promise.reject(new Error("controlled rejection"))
          : kind === "SQL"
            ? actual.query("SELECT forbidden_after_commit", [])
            : true,
      );
      return original(actual, scope, sourceHost);
    });
    mocks.preparation.mockImplementation(() => async () => undefined);
    await expect(f.ordinary.execute({ ...f.input, command: command() })).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.state.commits).toBe(1);
    expect(f.tx.query.mock.calls.some(([sql]) => sql.includes("forbidden_after_commit"))).toBe(
      false,
    );
  }
});
it("refuses Promise registration and preserves the failed source protocol if configure catches it", async () => {
  const f = fixture();
  f.state.replay = false;
  const original = f.configure.getMockImplementation();
  f.configure.mockImplementation((actual, scope, sourceHost) => {
    if (!original) throw new Error("controlled missing configure");
    try {
      Reflect.apply(sourceHost.registerAfterCommit, sourceHost, [
        actual,
        Promise.reject(new Error("controlled invalid registration")),
      ]);
    } catch {
      /* deliberately hostile controlled boundary */
    }
    return original(actual, scope, sourceHost);
  });
  mocks.preparation.mockImplementation(() => async () => undefined);
  await expect(f.ordinary.execute({ ...f.input, command: command() })).rejects.toMatchObject({
    code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.commits).toBe(0);
});
it("runs valid pure source finalization without a post-COMMIT clock check", async () => {
  const f = fixture();
  f.state.replay = false;
  f.state.afterCommitExpiry = true;
  const original = f.configure.getMockImplementation(),
    pure = vi.fn(() => undefined);
  f.configure.mockImplementation((actual, scope, sourceHost) => {
    if (!original) throw new Error("controlled missing configure");
    sourceHost.registerAfterCommit(actual, pure);
    return original(actual, scope, sourceHost);
  });
  mocks.preparation.mockImplementation(() => async () => undefined);
  expect(await f.ordinary.execute({ ...f.input, command: command() })).toBe(f.receipt);
  expect(pure).toHaveBeenCalledOnce();
  expect(f.state.commits).toBe(1);
});

it("supplies genuine Draft administrative authority to fresh owning reference holders only", async () => {
  const f = fixture();
  f.state.replay = false;
  let packet: unknown;
  mocks.preparation.mockImplementation(() => async () => {
    const call = f.configure.mock.calls[0];
    if (!call) throw new Error("Controlled configure required");
    const [actual, scope, host] = call;
    packet = await host.holdCurrentBrandAdministration(actual, {
      scope,
      observedAt: at,
      validUntil: until,
    });
    await host.registerBeforeCommit(
      actual,
      async () => {
        packet = await host.holdCurrentBrandAdministration(actual, {
          scope,
          observedAt: at,
          validUntil: until,
        });
      },
      () => undefined,
    );
  });
  await f.ordinary.execute({ ...f.input, command: command() });
  expect(packet).toMatchObject({
    administrationContext: {
      profile: "BrandAdministrationContextV1",
      brand: { lifecycle: "Draft" },
      store: null,
    },
    validUntil: until,
  });
});
it.each(["transaction", "scope", "window", "late"])(
  "refuses %s reference authority drift",
  async (field) => {
    const f = fixture();
    f.state.replay = false;
    mocks.preparation.mockImplementation((options) => async () => {
      const call = f.configure.mock.calls[0];
      if (!call) throw new Error("Controlled configure required");
      const [actual, scope, host] = call;
      if (field === "late") f.state.allowed = false;
      await host.holdCurrentBrandAdministration(
        field === "transaction" ? { query: actual.query } : actual,
        {
          scope: field === "scope" ? { ...scope, actorReference: id(98) } : scope,
          observedAt: at,
          validUntil: field === "window" ? "2026-10-06T10:00:06.000Z" : until,
        },
      );
      void options;
    });
    await expect(f.ordinary.execute({ ...f.input, command: command() })).rejects.toThrow();
    expect(f.state.commits).toBe(0);
  },
);

it("poisons a caught owning administrative authority failure before commit", async () => {
  const f = fixture();
  f.state.replay = false;
  mocks.preparation.mockImplementation(() => async () => {
    const call = f.configure.mock.calls[0];
    if (!call) throw new Error("Controlled configure required");
    const [actual, scope, host] = call;
    await expect(
      host.holdCurrentBrandAdministration(actual, {
        scope: { ...scope, brandReference: id(97) },
        observedAt: at,
        validUntil: until,
      }),
    ).rejects.toThrow();
  });
  await expect(f.ordinary.execute({ ...f.input, command: command() })).rejects.toThrow();
  expect(f.state.commits).toBe(0);
});
