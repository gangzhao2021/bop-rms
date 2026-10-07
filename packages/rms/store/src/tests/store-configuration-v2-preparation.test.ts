import { createHash } from "node:crypto";
import { beforeEach, describe, it, expect, vi } from "vitest";
const core = vi.hoisted(() => ({
  head: null as unknown,
  mutations: [] as import("@bop/publishing").ExecutePublishingMutationInput[],
  read: vi.fn(),
  candidate: vi.fn(),
  approval: vi.fn(),
  independent: vi.fn(),
  execute: vi.fn(),
}));
// Controlled public-owner boundaries exercise composition and ordering. They do
// not constitute native Publishing/IAM, reference-validation or Live Gate proof.
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: () => ({
    resolveCurrentLifecycleMutation: core.read,
    resolvePublicationCandidate: core.candidate,
    resolveCurrentApproval: core.approval,
    resolveCurrentIndependentApproval: core.independent,
  }),
  executePublishingMutation: core.execute,
}));
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { type ExecutePublishingMutationInput } from "@bop/publishing";
import { createStoreConfigurationVersion } from "../contracts/store-configuration-administration.js";
import { createStoreConfigurationPublicationHash } from "../contracts/store-configuration-publication-content.js";
import { createPersistentStoreConfigurationV2Preparation } from "../infrastructure/configuration-v2-preparation.js";
import { createPostgresStoreV2ApprovalAuthorization } from "../infrastructure/current-publication-proof.js";
import {
  parseStoreSetupDraft,
  storeSetupDraftContentFields,
} from "../contracts/store-setup-draft.js";
import { parseStoreSetupSaveCommand } from "../contracts/store-setup-operation.js";
import { parseStoreAdministrationReference } from "../contracts/store-configuration-administration.js";
const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T14:00:00.000Z";
const configuration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle,
  source: "StoreOverride",
  brandBaseVersionReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(5),
  contactReference: id(6),
  receiptReference: id(7),
  taxConfigurationReference: id(8),
  paymentConfigurationReference: id(9),
  capacityConfigurationReference: null,
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 0,
              leadTimeSeconds: 600,
            },
          ]
        : [],
  })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

const rawDigest = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
function savedSetup() {
  const config = createStoreConfigurationVersion(configuration("Draft")),
    fees = [
      { chargeType: "ServiceCharge", state: "Disabled" },
      { chargeType: "DeliveryFee", state: "Disabled" },
      { chargeType: "Tip", state: "Disabled" },
    ];
  return parseStoreSetupDraft({
    profile: "StoreSetupDraftV2",
    tenantReference: id(50),
    brandReference: id(2),
    storeReference: id(3),
    setupDraftReference: id(51),
    revision: 1,
    authoredByReference: id(10),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    baseConfigurationReference: null,
    content: {
      ...Object.fromEntries(
        storeSetupDraftContentFields.map((key) => [
          key,
          { state: "Configured", value: config[key] },
        ]),
      ),
      feeContexts: { state: "Configured", value: fees },
    },
    createdAt: at,
    updatedAt: at,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
  });
}
const modern = () => {
  const setup = savedSetup();
  if (setup.content.feeContexts?.state !== "Configured")
    throw new Error("controlled fixture incomplete");
  return createStoreConfigurationVersion({
    ...configuration("Draft"),
    setupBasis: {
      profile: "StoreSetupConfigurationBasisV2",
      tenantReference: id(50),
      setupDraftReference: id(51),
      sourceRevision: 1,
      sourceSnapshotDigest: rawDigest(setup),
      feeContexts: setup.content.feeContexts.value,
    },
  });
};
function setupRow() {
  const snapshot = savedSetup(),
    command = parseStoreSetupSaveCommand({
      profile: "StoreSetupSaveV2",
      tenantReference: id(50),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(10),
      operationReference: id(70),
      expectedSetupReference: null,
      expectedRevision: 0,
      purposeCode: "STORE_SETUP_DRAFT",
      content: snapshot.content,
    });
  return {
    snapshot_json: snapshot,
    snapshot_digest: rawDigest(snapshot),
    operation_id: id(70),
    actor_id: id(10),
    expected_setup_id: null,
    expected_revision: "0",
    intent_digest: rawDigest(command),
  };
}
const context = (actor: string) =>
  createTenantContext(
    {
      actorType: "User",
      actorReference: actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as Parameters<typeof createTenantContext>[0],
    createBrand({
      brandReference: id(2),
      code: "SYNTHETIC",
      displayName: "Synthetic",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    createStore({
      storeReference: id(3),
      brandReference: id(2),
      code: "SYNTHETIC",
      displayName: "Synthetic",
      timeZone: "America/Toronto",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    at,
  );
const hash = createStoreConfigurationPublicationHash({
  canonicalize: JSON.stringify,
  hashIntent: (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`,
});
function fixture() {
  let clock = at,
    ids = 100;
  const tx = {
      query: async (sql: string) => ({
        rows: sql.includes("store_setup_draft_revision") ? [setupRow()] : [],
      }),
    },
    validation = vi.fn(async () => ({
      validUntil: "2026-08-16T14:00:00.000Z",
      checkCodes: ["STORE_REFERENCE_CHECK"],
    })),
    approval = vi.fn(async () => "2026-08-16T13:00:00.000Z"),
    liveGate = vi.fn(async () => id(99)),
    allocation = vi.fn(() => id(ids++));
  const options = {
    tenantReference: id(50),
    brandReference: id(2),
    storeReference: id(3),
    publishingFamilyReference: id(52),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_OPERATION",
    originalObservedAt: at,
    originalValidUntil: "2026-08-15T14:00:05.000Z",
    clock: { now: () => clock },
    setupSnapshotReferences: {
      canonicalize: JSON.stringify,
      hashIntent: (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`,
    },
    requiredValidationCheckCodes: ["STORE_REFERENCE_CHECK"],
    nextReference: allocation,
    hashContent: hash,
    currentTenantContext: async (_tx: unknown, input: { actorReference: string }) =>
      context(input.actorReference),
    publishingAuthorization: () => ({
      authorize: async () => {
        throw new Error("controlled executor boundary must not pretend to run authorization");
      },
    }),
    validateSubmit: validation,
    approvalValidUntil: approval,
    liveGateEvidence: liveGate,
  };
  const helper = createPersistentStoreConfigurationV2Preparation(options),
    prepare = helper.forTransaction(tx);
  const input = (value: ReturnType<typeof modern>, actor = id(10), op = id(20)) => ({
    operationReference: parseStoreAdministrationReference(op),
    actorReference: parseStoreAdministrationReference(actor),
    purposeCode: "STORE.CONFIGURATION",
    auditReference: parseStoreAdministrationReference(id(21)),
    expectedVersion: 1,
    occurredAt: value.updatedAt,
    configuration: value,
  });
  return {
    prepare,
    input,
    allocation,
    validation,
    approval,
    liveGate,
    options,
    tx,
    setClock: (value: string) => {
      clock = value;
    },
  };
}
beforeEach(() => {
  core.head = null;
  core.mutations = [];
  vi.clearAllMocks();
  core.read.mockImplementation(async () => core.head);
  core.independent.mockResolvedValue({});
  core.execute.mockImplementation(async (input: ExecutePublishingMutationInput) => {
    core.mutations.push(input);
    core.head = {
      operation: input.operation,
      current: input.current,
      next: input.next,
      validationEvidence: input.validationEvidence ?? null,
      approvalEvidence: input.approvalEvidence ?? null,
      audit: { actor: { type: "User", reference: input.tenantContext.actor.actorReference } },
    };
    return { lifecycle: input.next, release: input.release ?? null, auditReference: input.auditId };
  });
});
describe("fresh V2 actual Core composition", () => {
  it("creates a real semantic Draft and SubmitReview with no future approval or release metadata", async () => {
    const h = fixture(),
      saved = modern(),
      result = await h.prepare("Submit", h.input(saved), saved);
    expect(core.mutations).toHaveLength(2);
    expect(core.mutations).toMatchObject([
      {
        operation: "CreateDraft",
        next: {
          lifecycleId: saved.configurationReference,
          snapshotDigest: hash(saved),
          state: "Draft",
        },
      },
      {
        operation: "SubmitReview",
        next: { state: "InReview" },
        validationEvidence: { checkCodes: ["STORE_REFERENCE_CHECK"] },
      },
    ]);
    expect(result).toMatchObject({
      lifecycle: "PendingApproval",
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
      liveGateEvidenceReference: null,
    });
    expect(hash(result)).toBe(hash(saved));
  });
  it("approves only the recorded Submit with an independent actor and explicit clamped deadline", async () => {
    const h = fixture(),
      saved = modern(),
      submitted = await h.prepare("Submit", h.input(saved), saved);
    const approved = await h.prepare("Approve", h.input(submitted, id(11), id(22)), submitted);
    expect(core.mutations).toHaveLength(3);
    expect(approved).toMatchObject({
      lifecycle: "Approved",
      approvedByReference: id(11),
      publicationReference: null,
      liveGateEvidenceReference: null,
    });
    expect(core.independent).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotDigest: hash(saved),
        requiredCheckCodes: ["STORE_REFERENCE_CHECK"],
      }),
    );
  });
  it("publishes with the actual Core release and actual Live Gate evidence", async () => {
    const h = fixture(),
      saved = modern(),
      submitted = await h.prepare("Submit", h.input(saved), saved),
      approved = await h.prepare("Approve", h.input(submitted, id(11), id(22)), submitted),
      review = core.mutations[1],
      approval = core.mutations[2];
    if (!review?.validationEvidence || !approval?.approvalEvidence)
      throw new Error("controlled recorded evidence missing");
    core.candidate.mockResolvedValue({
      lifecycle: approval.next,
      validationEvidence: review.validationEvidence,
      approvalEvidence: approval.approvalEvidence,
      previousRelease: null,
    });
    const published = await h.prepare("Publish", h.input(approved, id(11), id(23)), approved),
      mutation = core.mutations[3];
    expect(published).toMatchObject({ lifecycle: "Published", liveGateEvidenceReference: id(99) });
    expect(published.publicationReference).toBe(mutation?.release?.releaseId);
    expect(hash(published)).toBe(hash(saved));
    expect(mutation).toMatchObject({
      operation: "Publish",
      next: { state: "Published" },
      release: { snapshotDigest: hash(saved), createdAt: at },
    });
  });
  it("poisons a swallowed reentry and rejects a source that advances beyond the lease", async () => {
    const h = fixture(),
      saved = modern();
    h.validation.mockImplementation(async () => {
      try {
        await h.prepare("Submit", h.input(saved), saved);
      } catch {
        /* Deliberately swallowed by controlled external source. */
      }
      return { validUntil: "2026-08-16T14:00:00.000Z", checkCodes: ["STORE_REFERENCE_CHECK"] };
    });
    await expect(h.prepare("Submit", h.input(saved), saved)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(core.mutations).toHaveLength(0);
    const late = fixture();
    late.validation.mockImplementation(async () => {
      late.setClock("2026-08-15T14:00:05.000Z");
      return { validUntil: "2026-08-16T14:00:00.000Z", checkCodes: ["STORE_REFERENCE_CHECK"] };
    });
    await expect(late.prepare("Submit", late.input(saved), saved)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(core.mutations).toHaveLength(0);
  });
  it("refuses the original author or Submit actor before approval allocation", async () => {
    const h = fixture(),
      saved = modern(),
      submitted = await h.prepare("Submit", h.input(saved), saved),
      before = h.allocation.mock.calls.length;
    await expect(h.prepare("Approve", h.input(submitted), submitted)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(h.allocation.mock.calls).toHaveLength(before);
    expect(core.mutations).toHaveLength(2);
  });
  it("refuses changed business content, missing validation inventory, and expired original authorization", async () => {
    const h = fixture(),
      saved = modern();
    await expect(
      h.prepare(
        "Submit",
        h.input(createStoreConfigurationVersion({ ...saved, addressReference: id(90) })),
        saved,
      ),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE" });
    expect(core.mutations).toHaveLength(0);
    expect(h.allocation).not.toHaveBeenCalled();
    const next = fixture();
    next.validation.mockResolvedValue({
      validUntil: "2026-08-16T14:00:00.000Z",
      checkCodes: ["UNRELATED_CHECK"],
    });
    await expect(next.prepare("Submit", next.input(saved), saved)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(core.mutations).toHaveLength(0);
    const expired = fixture();
    expired.setClock("2026-08-15T14:00:05.000Z");
    await expect(expired.prepare("Submit", expired.input(saved), saved)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("refuses forged immutable Setup provenance before Core allocation", async () => {
    const h = fixture(),
      saved = modern(),
      forged = createStoreConfigurationVersion({
        ...saved,
        setupBasis: { ...saved.setupBasis, sourceSnapshotDigest: `sha256:${"a".repeat(64)}` },
      });
    await expect(h.prepare("Submit", h.input(forged), forged)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(h.allocation).not.toHaveBeenCalled();
    expect(core.mutations).toHaveLength(0);
  });
  it("refuses captured query/authority replacement and a deadline longer than the original lease", async () => {
    const h = fixture();
    h.options.currentTenantContext = async () => context(id(11));
    await expect(h.prepare("Submit", h.input(modern()), modern())).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(core.mutations).toHaveLength(0);
    const other = fixture();
    expect(() =>
      createPersistentStoreConfigurationV2Preparation({
        ...other.options,
        originalValidUntil: "2026-08-15T14:00:06.000Z",
      }),
    ).toThrow();
  });
});

it("reads V2 actual Approved and independent history without any future publication snapshot", async () => {
  const h = fixture(),
    saved = modern(),
    submitted = await h.prepare("Submit", h.input(saved), saved),
    approved = await h.prepare("Approve", h.input(submitted, id(11), id(22)), submitted);
  const mutation = core.mutations[2],
    review = core.mutations[1];
  if (
    !mutation ||
    !review ||
    mutation.approvalEvidence === undefined ||
    review.validationEvidence === undefined
  )
    throw new Error("controlled actual construction missing");
  const {
      createPublishingLifecycleRecord,
      createPublishingApprovalEvidence,
      createPublishingValidationEvidence,
    } = await import("@bop/publishing"),
    head = createPublishingLifecycleRecord(mutation.next),
    approval = createPublishingApprovalEvidence(mutation.approvalEvidence),
    validation = createPublishingValidationEvidence(review.validationEvidence);
  core.candidate.mockResolvedValue({
    lifecycle: head,
    approvalEvidence: approval,
    validationEvidence: validation,
  });
  const independent = {
    profile: "CurrentIndependentPublishingApprovalV1",
    tenantReference: id(50),
    scope: head.scope,
    familyReference: head.familyReference,
    lifecycleReference: head.lifecycleId,
    configurationType: head.configurationType,
    purposeCode: head.purposeCode,
    snapshotReference: head.snapshotReference,
    snapshotDigest: head.snapshotDigest,
    approvedLifecycleVersion: head.version,
    reviewVersion: approval.reviewVersion,
    approvalEvidenceReference: approval.evidenceReference,
    validationEvidenceReference: validation.evidenceReference,
    approvedByActorReference: approval.approvedActorReference,
    requestedByActorReference: id(10),
    recordedIndependence: "Verified",
    validationCheckCodes: ["STORE_REFERENCE_CHECK"],
    observedAt: at,
  };
  core.independent.mockResolvedValue(independent);
  const authorize = createPostgresStoreV2ApprovalAuthorization({
    tenantReference: id(50),
    brandReference: id(2),
    storeReference: id(3),
    publishingFamilyReference: id(52),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_OPERATION",
    hashContent: hash,
    authorize: async () => true,
    requiredValidationCheckCodes: ["STORE_REFERENCE_CHECK"],
  });
  await expect(authorize(h.tx, approved, at)).resolves.toMatchObject({
    configuration: approved,
    contentDigest: hash(saved),
  });
  core.independent.mockResolvedValue({ ...independent, familyReference: id(80) });
  await expect(authorize(h.tx, approved, at)).rejects.toThrow("STORE_CURRENT_APPROVAL_UNAVAILABLE");
  core.independent.mockResolvedValue({ ...independent, requestedByActorReference: id(11) });
  await expect(authorize(h.tx, approved, at)).rejects.toThrow("STORE_CURRENT_APPROVAL_UNAVAILABLE");
});
