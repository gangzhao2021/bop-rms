import { beforeEach, expect, it, vi } from "vitest";
import { CatalogError } from "@rms/catalog";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import { validateAuditRecord } from "@bop/audit";
import {
  createPublishingLifecycleRecord,
  createPublishingScope,
  createPublishingValidationEvidence,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingVersion,
  optionSetPublicationOperationFields,
  parsePublishingInstant,
  parsePublishingReference,
  type OptionSetPublicationOperationStoreOptions,
} from "@bop/publishing";
import { createMerchantOptionSetPublicationResolutionCommand } from "./merchant-option-set-publication-resolution-command.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: () => mocks.current(),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: () => mocks.capability(),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresOptionSetPublicationOperationStore: (o: unknown) => ({
    resolveOperation: (tx: unknown, c: unknown) => mocks.resolve(o, tx, c),
  }),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "01902421-7700-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z",
  hash = "sha256:" + "a".repeat(64);
type Owner = OptionSetPublicationOperationStoreOptions;
type Tx = Parameters<Owner["registerBeforeCommit"]>[0];
type Command = Parameters<Owner["authority"]["holdUntilTransactionCompletes"]>[1]["command"];
function harness() {
  const body = {
    profile: "CatalogOptionSetPublicationResolutionRequestV1",
    action: "SubmitReview",
    operationReference: id(7),
    optionSetReference: id(6),
    versionReference: id(8),
    expectedAggregateVersion: 1,
    sourceDigest: hash,
    contentDigest: hash,
    configurationDigest: hash,
    expectedReview: null,
    expectedLifecycle: null,
  };
  const state = {
    now: at,
    deadline: until,
    capabilityDeadline: until,
    allowed: true,
    committed: false,
    failCommit: false,
  };
  const tx = {
    query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
      void _sql;
      void _values;
      return { rows: [] };
    }),
  };
  const current = {
      assertCurrent: vi.fn(() => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return state.now;
      }),
      authorizeActionsWithDecisions: vi.fn(async (actions: readonly string[]) => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return actions.map((action) => ({
          effect: "Allow",
          reason: "ROLE_PERMISSION",
          source: "RolePermission",
          action: parseBusinessAction(action),
          scopeKind: "Brand",
          policySnapshotReference: parsePolicyReference(id(21)),
          policyVersion: parsePolicyVersion(1),
          audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
        }));
      }),
      leaseDeadline: vi.fn(() => state.deadline),
    },
    capability = {
      holdUntilCommit: vi.fn(async () => undefined),
      leaseDeadline: vi.fn(() => state.capabilityDeadline),
    };
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  let hostTx: Tx | undefined;
  mocks.scope.mockImplementation(async (actual: Tx) => {
    hostTx = actual;
    return {
      tenantReference: id(1),
      actorReference: id(4),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
    };
  });
  const authorityInput = (command: Command) => ({
    command,
    mode: "Resolve" as const,
    permission: "catalog.manage" as const,
    requiredPermissions: ["catalog.option_set.read"],
    requiredFields: optionSetPublicationOperationFields,
    purposeCode: "CATALOG_OPTION_SET_PUBLICATION_OPERATION" as const,
    actorKind: "User" as const,
    observedAt: state.now,
    validUntil:
      state.deadline < state.capabilityDeadline ? state.deadline : state.capabilityDeadline,
  });
  const owner = async (o: Owner, t: Tx, c: Command) => {
    expect(t).toBe(hostTx);
    expect(await o.authority.holdUntilTransactionCompletes(t, authorityInput(c))).toEqual({
      validUntil:
        state.deadline < state.capabilityDeadline ? state.deadline : state.capabilityDeadline,
    });
    await o.registerBeforeCommit(
      t,
      async () => {
        await o.authority.holdUntilTransactionCompletes(t, authorityInput(c));
      },
      () => undefined,
    );
    const audit = o.audit.create({ command: c, observedAt: parsePublishingInstant(state.now) });
    expect(audit).toMatchObject({
      actor: { type: "User", reference: id(4) },
      brandId: id(2),
      actionCode: "PUBLISHING_OPTION_SET_OPERATION_ABANDONED",
      dataClassification: "Confidential",
      occurredAt: state.now,
    });
    expect(audit).not.toHaveProperty("storeId");
    return Object.freeze({
      outcome: "Abandoned" as const,
      command: c,
      recordedAt: parsePublishingInstant(state.now),
      auditReference: parsePublishingReference(audit.auditId),
    });
  };
  mocks.resolve.mockImplementation(owner);
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    merchant = {
      now: () => state.now,
      transactions: {
        async run<T>(work: (t: typeof tx) => Promise<T>) {
          const value = await work(tx);
          if (state.failCommit) throw Error("controlled COMMIT failure");
          state.committed = true;
          return value;
        },
      },
    };
  const options = {
    merchant: merchant as unknown as Parameters<
      typeof createMerchantOptionSetPublicationResolutionCommand
    >[0]["merchant"],
    authentication: authentication as unknown as Parameters<
      typeof createMerchantOptionSetPublicationResolutionCommand
    >[0]["authentication"],
    auditReference: () => id(10),
    optionSetPolicyFamilyReference: id(30),
  };
  const request = {
    sessionCookie: "synthetic-session",
    csrf: "synthetic-csrf",
    command: body,
    expectedScope: { brandReference: id(2), storeReference: id(3) },
  };
  return {
    body,
    state,
    tx,
    current,
    capability,
    options,
    request,
    owner,
    authorityInput,
    authentication,
    execute: () => createMerchantOptionSetPublicationResolutionCommand(options)(request),
  };
}
it("derives actual identity and returns terminal absence only after original host COMMIT", async () => {
  const h = harness(),
    result = await h.execute();
  expect(h.state.committed).toBe(true);
  expect(result).toMatchObject({
    profile: "CatalogOptionSetPublicationResolutionResultV1",
    storeReference: id(3),
    resolution: {
      outcome: "Abandoned",
      command: {
        tenantReference: id(1),
        actorReference: id(4),
        selectedStoreReference: id(3),
        reasonCode: "PUBLISHING_REVIEW_SUBMITTED",
      },
    },
  });
  expect(h.current.authorizeActionsWithDecisions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.option_set.read",
  ]);
});
it.each([
  "tenantReference",
  "actorReference",
  "brandReference",
  "storeReference",
  "occurredAt",
  "content",
])("rejects client %s before authentication", async (field) => {
  const h = harness();
  h.request.command = { ...h.body, [field]: id(99) };
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(h.authentication.authorize).not.toHaveBeenCalled();
});
it("does not return a tentative result when actual outer COMMIT fails", async () => {
  const h = harness();
  h.state.failCommit = true;
  await expect(h.execute()).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});
it("missing complete owning decisions is not a void Allow fallback", async () => {
  const h = harness();
  h.current.authorizeActionsWithDecisions.mockResolvedValue([]);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects late permission withdrawal during owner final guard", async () => {
  const h = harness();
  mocks.resolve.mockImplementation(async (o: Owner, t: Tx, c: Command) => {
    const result = await h.owner(o, t, c);
    h.state.allowed = false;
    return result;
  });
  await expect(h.execute()).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});
it("rejects original deadline expiry without extending the lease", async () => {
  const h = harness();
  mocks.resolve.mockImplementation(async (o: Owner, t: Tx, c: Command) => {
    const result = await h.owner(o, t, c);
    h.state.now = until;
    return result;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects a substituted captured permission port", async () => {
  const h = harness();
  mocks.resolve.mockImplementation(async (o: Owner, t: Tx, c: Command) => {
    const result = await h.owner(o, t, c);
    h.current.authorizeActionsWithDecisions = vi.fn(async () => []);
    return result;
  });
  await expect(h.execute()).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});
it("rejects a foreign original command even if a source returns a terminal result", async () => {
  const h = harness();
  mocks.resolve.mockImplementation(async (o: Owner, t: Tx, c: Command) => ({
    ...(await h.owner(o, t, c)),
    command: { ...c, actorReference: id(99) },
  }));
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("requires the owning authority exact Resolve purpose and inventory", async () => {
  const h = harness();
  mocks.resolve.mockImplementation(async (o: Owner, t: Tx, c: Command) =>
    o.authority.holdUntilTransactionCompletes(t, { ...h.authorityInput(c), mode: "Write" }),
  );
  await expect(h.execute()).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});

it("returns the immutable original full Review mutation after COMMIT without reading current Draft", async () => {
  const h = harness();
  mocks.resolve.mockImplementation(async (o: Owner, t: Tx, c: Command) => {
    await h.owner(o, t, c);
    const scope = createPublishingScope({
        kind: "Brand",
        brandReference: id(2),
        storeReference: null,
      }),
      draft = createPublishingLifecycleRecord({
        lifecycleId: parsePublishingReference(id(31)),
        familyReference: c.optionSetReference,
        configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
        purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
        snapshotReference: c.versionReference,
        snapshotDigest: parsePublishingDigest(hash),
        scope,
        version: parsePublishingVersion(1),
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: parsePublishingInstant(at),
        changedAt: parsePublishingInstant(at),
      }),
      evidence = createPublishingValidationEvidence({
        evidenceReference: parsePublishingReference(id(32)),
        snapshotReference: draft.snapshotReference,
        snapshotDigest: draft.snapshotDigest,
        scope,
        result: "Pass",
        checkedAt: parsePublishingInstant(at),
        validUntil: parsePublishingInstant(until),
        checkCodes: [parsePublishingCode("CURRENT_REFERENCES")],
      }),
      next = createPublishingLifecycleRecord({
        ...draft,
        version: parsePublishingVersion(2),
        state: "InReview",
        validationEvidenceReference: evidence.evidenceReference,
      }),
      audit = validateAuditRecord(
        {
          auditId: id(33),
          brandId: id(2),
          actor: { type: "User", reference: id(4) },
          actionCode: "PUBLISHING_REVIEW_SUBMITTED",
          targetType: "PublishingLifecycle",
          targetId: draft.lifecycleId,
          reasonCode: c.reasonCode,
          correlationId: c.operationReference,
          occurredAt: at,
          sourceChannel: "API",
          dataClassification: "Confidential",
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        },
        Date.parse(at),
      );
    return {
      outcome: "Committed",
      command: c,
      originalOccurredAt: parsePublishingInstant(at),
      auditReference: parsePublishingReference(audit.auditId),
      mutation: {
        operation: "SubmitReview",
        expectedVersion: draft.version,
        idempotencyKey: c.operationReference,
        current: draft,
        next,
        validationEvidence: evidence,
        approvalEvidence: null,
        release: null,
        supersededReleaseId: null,
        rollbackTargetReleaseId: null,
        audit,
      },
    };
  });
  const result = await h.execute();
  expect(h.state.committed).toBe(true);
  expect(result.resolution).toMatchObject({
    outcome: "Committed",
    originalOccurredAt: at,
    mutation: { operation: "SubmitReview", idempotencyKey: id(7), audit: { auditId: id(33) } },
  });
  expect(h.tx.query.mock.calls.some((call) => String(call[0]).includes("option_set"))).toBe(false);
});
it.each([
  ["Approve", "InReview", "PUBLISHING_REVIEW_APPROVED"],
  ["Publish", "Approved", "PUBLISHING_RELEASE_PUBLISHED"],
])(
  "Resolve binds the same server audit reason for %s",
  async (action, lifecycleState, reasonCode) => {
    const h = harness();
    const result = await createMerchantOptionSetPublicationResolutionCommand(h.options)({
      ...h.request,
      command: {
        ...h.body,
        action,
        expectedReview: {
          reviewOperationReference: id(34),
          publishingReviewOperationReference: id(35),
          recordDigest: hash,
          bindingDigest: hash,
        },
        expectedLifecycle: {
          lifecycleReference: id(31),
          version: 3,
          state: lifecycleState,
          latestMutationOperationReference: lifecycleState === "InReview" ? id(35) : id(36),
        },
      },
    });
    expect(result.resolution.command.reasonCode).toBe(reasonCode);
    expect(h.state.committed).toBe(true);
  },
);
it("requires actual shortest Feature lease and rejects its expiry", async () => {
  const h = harness();
  h.state.capabilityDeadline = "2026-10-04T12:00:00.001Z";
  mocks.resolve.mockImplementation(async (o: Owner, t: Tx, c: Command) => {
    const result = await h.owner(o, t, c);
    h.state.now = "2026-10-04T12:00:00.001Z";
    return result;
  });
  await expect(h.execute()).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});
