import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import { parseProductAggregate } from "../contracts/product.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  parseProductPublicationValidation,
  planCatalogProductPublication,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  resolveCatalogProductPublication,
  type ProductPublicationCommand,
} from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationVersionV2,
  parseProductPublicationValidationV2,
} from "../contracts/product-publication-v2.js";
import {
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductPublicationReplacementIntent,
} from "../contracts/product-scope-replacement-intent.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import { buildProductPublicationSourceSnapshot } from "../contracts/product-publication-source.js";
import {
  buildCatalogProductApprovalReceipt,
  parseCatalogProductApprovalReceipt,
} from "../contracts/product-approval-receipt.js";
import { createProductPublicationScheduledActivator } from "../application/product-publication-scheduler.js";
import {
  createPostgresProductPublicationStore,
  createPostgresProductPublicationStoreV2,
} from "../infrastructure/persistence/product-publication-store.js";
import { createPostgresProductWholeScopeReplacementStore } from "../infrastructure/persistence/product-whole-scope-replacement-store.js";

const id = (n: number) => `01902421-0130-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-02T12:00:00.000Z";
const later = "2026-10-02T13:00:00.000Z";
const until = "2026-10-03T12:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
function fixture() {
  const aggregate = parseProductAggregate({
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_V2_BOUNDARY",
    productType: "PreparedFood",
    lifecycle: "Active",
    aggregateVersion: 4,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic boundary fixture" },
      taxClassificationReference: id(60),
      createdAt: at,
      updatedAt: at,
      skus: [],
      optionBindings: [],
    },
  });
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const base = parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 4,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Store", reference: id(7), channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: { timeZone: "UTC", effectiveFrom: boundary(at), effectiveUntil: null },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_BOUNDARY",
  });
  const body = {
    profile: "CatalogProductExactStoreSelectorReplacementV1",
    mode: "PermanentSelectorRetirement",
    previousVersionReference: id(30),
    previousPublicationOperationReference: id(31),
    expectedPreviousPublicationVersion: 3,
    previousIntentDigest: hash("synthetic original command"),
    previousScopeDigest: hash("synthetic original scope"),
    previousPeriodDigest: hash(base.effectivePeriod),
    previousSelectorIndex: 0,
    previousSelectorDigest: hash(base.scopeSet[0]),
  };
  const replacementIntent = parseCatalogProductScopeReplacementIntent({
    ...body,
    digest: hash(body),
  });
  const replacement = { replacementIntent, replacementIntentDigest: replacementIntent.digest };
  const command = parseProductPublicationCommandV2({
    ...base,
    profile: "CatalogProductPublicationCommandV2",
    ...replacement,
  });
  const facts = (c: ProductPublicationCommand) => ({
    now: at,
    productAggregateVersion: c.expectedProductAggregateVersion,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    validation: {
      evidenceReference: id(10),
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(11),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: until,
    },
    approval: null,
    reviewReference: null,
    replacement: null,
  });
  const draft = planCatalogProductPublication(base, null, facts(base));
  const version = parseProductPublicationVersionV2({
    ...draft,
    profile: "CatalogProductPublicationVersionV2",
    ...replacement,
    intentDigest: hash(command),
  });
  return { aggregate, base, command, draft, version, replacement, facts };
}
const inputInvalid = expect.objectContaining({ code: "CATALOG_INPUT_INVALID" });

describe("explicit V2 never enters legacy V1 runtime", () => {
  it("refuses the command before transaction, authority, source, clock or audit callbacks", async () => {
    const x = fixture();
    const callbacks = {
      run: vi.fn(),
      now: vi.fn(() => at),
      holdUntilTransactionCompletes: vi.fn(),
      withHeldCurrentFacts: vi.fn(),
      withHeldScopePolicy: vi.fn(),
      create: vi.fn(),
    };
    const owner = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      authority: callbacks,
      sources: callbacks,
      audit: callbacks,
    };
    const store = createPostgresProductPublicationStore({
      ...owner,
      actorKind: "User",
      clock: callbacks,
      transactions: callbacks,
    });
    await expect(store.execute(x.command)).rejects.toThrow(inputInvalid);
    const whole = createPostgresProductWholeScopeReplacementStore({
      publish: owner,
      supersede: { ...owner, actorReference: id(40) },
      clock: callbacks,
      transactions: callbacks,
    });
    await expect(whole.execute({ publish: x.command, supersede: x.base })).rejects.toThrow(
      inputInvalid,
    );
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it("refuses a valid V2 Scheduled version before IDs or writer execution", async () => {
    const x = fixture();
    const period = { ...x.base.effectivePeriod, effectiveFrom: boundary(later) };
    const c = { ...x.base, effectivePeriod: period };
    const draft = planCatalogProductPublication(c, null, x.facts(c));
    const submit = {
      ...c,
      action: "SubmitReview" as const,
      expectedPublicationVersion: 1,
      operationReference: id(41),
    };
    const review = planCatalogProductPublication(submit, draft, {
      ...x.facts(submit),
      reviewReference: id(42),
    });
    const schedule = {
      ...submit,
      action: "SchedulePublish" as const,
      expectedPublicationVersion: 2,
      scheduleReference: id(43),
      operationReference: id(44),
    };
    const scheduled = planCatalogProductPublication(schedule, review, x.facts(schedule));
    const publication = parseProductPublicationVersionV2({
      ...scheduled,
      profile: "CatalogProductPublicationVersionV2",
      ...x.replacement,
    });
    const operation = vi.fn(),
      successorDraft = vi.fn(),
      execute = vi.fn();
    const activator = createProductPublicationScheduledActivator({
      tenantReference: id(1),
      brandReference: id(2),
      systemActorReference: id(40),
      references: { operation, successorDraft },
      writer: { execute },
    });
    await expect(activator.activate({ publication, expectedAggregateVersion: 5 })).rejects.toThrow(
      inputInvalid,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(successorDraft).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not label V2 history Complete through the V1 source builder", () => {
    const x = fixture();
    const aggregate = parseProductAggregate({ ...x.aggregate, aggregateVersion: 5 });
    const revision = {
      action: "Validate",
      publication: x.draft,
      aggregate,
      content: null,
      coherent: true,
      snapshotDigest: hash(aggregate),
    };
    const raw = { aggregateVersion: 5, observedAt: at, revisions: [revision] };
    const scope = { tenantReference: id(1), brandReference: id(2) };
    const request = { productReference: id(5), expectedAggregateVersion: 5 };
    expect(buildProductPublicationSourceSnapshot(raw, scope, request, at).coverage).toBe(
      "Complete",
    );
    expect(() =>
      buildProductPublicationSourceSnapshot(
        { ...raw, revisions: [{ ...revision, publication: x.version }] },
        scope,
        request,
        at,
      ),
    ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
  });

  it("does not strip replacement binding from V1 approval receipts or resolution", () => {
    const x = fixture();
    const approved = parseProductPublicationVersion({
      ...x.draft,
      state: "Approved",
      publicationVersion: 3,
      approvalPolicy: "Required",
      reviewReference: id(12),
      reviewVersion: 2,
      submittedByActorReference: id(3),
      approvalEvidenceReference: id(13),
      actorReference: id(14),
      operationReference: id(15),
    });
    const approval = {
      evidenceReference: id(13),
      reviewReference: id(12),
      reviewVersion: 2,
      requestedByActorReference: id(3),
      approvedByActorReference: id(14),
      contentDigest: approved.contentDigest,
      configurationDigest: approved.configurationDigest,
      scopeDigest: approved.scopeDigest,
      periodDigest: approved.periodDigest,
      policyReference: approved.policyReference,
      policyVersion: approved.policyVersion,
      approvedAt: at,
      validUntil: until,
    };
    const receipt = buildCatalogProductApprovalReceipt(approved, approval);
    const approvalV2 = {
      ...approval,
      profile: "CatalogProductPublicationApprovalV2",
      replacementIntentDigest: x.replacement.replacementIntentDigest,
    };
    const approvedV2 = parseProductPublicationVersionV2({
      ...approved,
      profile: "CatalogProductPublicationVersionV2",
      ...x.replacement,
    });
    expect(() => buildCatalogProductApprovalReceipt(approvedV2, approval)).toThrow(inputInvalid);
    expect(() => buildCatalogProductApprovalReceipt(approved, approvalV2)).toThrow(inputInvalid);
    const body = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "digest"));
    const mixedBody = { ...body, approval: approvalV2 };
    expect(() =>
      parseCatalogProductApprovalReceipt({ ...mixedBody, digest: hash(mixedBody) }),
    ).toThrow(inputInvalid);
    const context = {
      storeReference: id(7),
      storeGroupReferences: [],
      regionReferences: [],
      channelCode: "POS",
      orderTypeCode: "DINE_IN",
      at,
    };
    expect(() =>
      resolveCatalogProductPublication([x.version], context, productPublicationScopeLevels),
    ).toThrow(inputInvalid);
  });
});

it("does not widen legacy V1 validation or version parsers for Pending even after removing V2 envelopes", () => {
  const x = fixture();
  const v = x.facts(x.base).validation;
  const pendingBase = {
    ...v,
    approvalPolicy: "Required",
    checks: v.checks.map((check) => ({
      ...check,
      outcome: check.code === "ApprovalPolicy" ? "Pending" : check.outcome,
    })),
  };
  const pending = parseProductPublicationValidationV2({
    ...pendingBase,
    profile: "CatalogProductPublicationValidationV2",
    replacementIntentDigest: x.command.replacementIntentDigest,
  });
  expect(() => parseProductPublicationValidation(pending)).toThrow(inputInvalid);
  expect(() => parseProductPublicationValidation(pendingBase)).toThrow(inputInvalid);
  const version = parseProductPublicationVersionV2({
    ...x.version,
    approvalPolicy: "Required",
    validationDecision: "ApprovalPending",
  });
  expect(() => parseProductPublicationVersion(version)).toThrow(inputInvalid);
  const { profile, replacementIntent, replacementIntentDigest, ...stripped } = version;
  expect(profile).toBe("CatalogProductPublicationVersionV2");
  expect(replacementIntent.digest).toBe(replacementIntentDigest);
  expect(() => parseProductPublicationVersion(stripped)).toThrow(inputInvalid);
});

it("keeps a None V2 publication out of V1 writer admission before every callback", async () => {
  const x = fixture(),
    body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const replacementIntent = parseCatalogProductPublicationReplacementIntent({
    ...body,
    digest: hash(body),
  });
  const command = parseProductPublicationCommandV2({
    ...x.command,
    replacementIntent,
    replacementIntentDigest: replacementIntent.digest,
  });
  const callbacks = {
    run: vi.fn(),
    now: vi.fn(() => at),
    holdUntilTransactionCompletes: vi.fn(),
    withHeldCurrentFacts: vi.fn(),
    create: vi.fn(),
  };
  const store = createPostgresProductPublicationStore({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    authority: callbacks,
    sources: callbacks,
    audit: callbacks,
    clock: callbacks,
    transactions: callbacks,
  });
  await expect(store.execute(command)).rejects.toThrow(inputInvalid);
  for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
});

it("keeps the optional outer-commit hook server-only and requires a callable registration port", async () => {
  const x = fixture(),
    callbacks = {
      run: vi.fn(),
      now: vi.fn(() => at),
      holdUntilTransactionCompletes: vi.fn(),
      withHeldCurrentFacts: vi.fn(),
      withCurrentPolicy: vi.fn(),
      create: vi.fn(),
      registerBeforeCommit: vi.fn(),
    },
    options = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User" as const,
      maximumApprovalValiditySeconds: 300,
      authority: callbacks,
      sources: callbacks,
      audit: callbacks,
      clock: callbacks,
      transactions: callbacks,
      registerBeforeCommit: callbacks.registerBeforeCommit,
    };
  for (const value of [null, {}, true])
    expect(() =>
      createPostgresProductPublicationStoreV2({ ...options, registerBeforeCommit: value as never }),
    ).toThrow();
  const store = createPostgresProductPublicationStoreV2(options);
  await expect(
    store.execute({ ...x.command, registerBeforeCommit: "caller supplied" }),
  ).rejects.toThrow(inputInvalid);
  for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
});
