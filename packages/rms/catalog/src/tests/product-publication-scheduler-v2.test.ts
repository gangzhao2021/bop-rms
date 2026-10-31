import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import {
  parseProductPublicationVersion,
  productPublicationCheckCodes,
} from "../contracts/product-publication.js";
import {
  planCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
  type ProductPublicationFactsV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import {
  deriveCatalogProductPublicationContentIdentity,
  createCatalogProductPublicationMaterializationV2,
} from "../contracts/product-publication-content.js";
import {
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductPublicationReplacementIntent,
} from "../contracts/product-scope-replacement-intent.js";
import { buildCatalogProductScopeRetirementHeader } from "../contracts/product-scope-retirement.js";
import { buildCatalogProductPublicationValidationReport } from "../contracts/product-publication-validation-report.js";
import {
  createProductPublicationScheduledActivator,
  createProductPublicationScheduledActivatorV2,
  type DueProductPublicationCandidateV2,
} from "../application/product-publication-scheduler.js";
import type { ProductPublicationWriteResultV2 } from "../infrastructure/persistence/product-publication-store.js";

const id = (n: number) => "01902452-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  before = "2026-10-02T10:00:00.000Z",
  scheduledAt = "2026-10-02T11:00:00.000Z",
  planned = "2026-10-02T12:00:00.000Z",
  actual = "2026-10-02T12:30:00.000Z",
  expiry = "2026-10-02T13:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
function fixture(noReplacement = false) {
  const source = parseProductAggregate({
      productReference: id(3),
      brandReference: id(2),
      internalCode: "SYNTHETIC_SCHEDULE",
      productType: "PreparedFood",
      lifecycle: "Active",
      aggregateVersion: 9,
      createdAt: before,
      createdByActorReference: id(4),
      updatedAt: scheduledAt,
      draft: {
        versionReference: id(6),
        baseVersionReference: noReplacement ? null : id(5),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic scheduler" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: before,
        updatedAt: before,
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(source),
    scopes = [30, 31].map((n) => ({
      level: "Store" as const,
      reference: id(n),
      channelCodes: ["WEB"],
      orderTypeCodes: ["PICKUP"],
    })),
    oldPeriod = { timeZone: "UTC", effectiveFrom: boundary(before), effectiveUntil: null },
    previous = parseProductPublicationVersion({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(3),
      versionReference: id(5),
      publicationVersion: 3,
      productAggregateVersion: 4,
      state: "Published",
      contentDigest: hash("synthetic old content"),
      configurationDigest: hash("synthetic old configuration"),
      scopeSet: scopes,
      scopeDigest: hash(scopes),
      effectivePeriod: oldPeriod,
      periodDigest: hash(oldPeriod),
      validationEvidenceReference: id(10),
      validationDecision: "Pass",
      policyReference: id(11),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      reviewReference: id(12),
      reviewVersion: 2,
      submittedByActorReference: id(4),
      approvalEvidenceReference: null,
      scheduleReference: null,
      scheduleVersion: 0,
      publishedAt: before,
      supersededAt: null,
      supersededByVersionReference: null,
      successorDraftVersionReference: id(6),
      operationReference: id(15),
      intentDigest: hash("synthetic old command"),
      actorReference: id(4),
      actorKind: "User",
      occurredAt: before,
      reasonCode: "SYNTHETIC_PUBLISH",
    }),
    body = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: previous.versionReference,
      previousPublicationOperationReference: previous.operationReference,
      expectedPreviousPublicationVersion: previous.publicationVersion,
      previousIntentDigest: previous.intentDigest,
      previousScopeDigest: previous.scopeDigest,
      previousPeriodDigest: previous.periodDigest,
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(scopes[0]),
    },
    noneBody = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    replacementIntent = noReplacement
      ? parseCatalogProductPublicationReplacementIntent({ ...noneBody, digest: hash(noneBody) })
      : parseCatalogProductScopeReplacementIntent({ ...body, digest: hash(body) });
  function command(
    action: ProductPublicationCommandV2["action"],
    index: number,
  ): ProductPublicationCommandV2 {
    return {
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      operationReference: id(100 + index),
      productReference: id(3),
      versionReference: id(6),
      expectedProductAggregateVersion: 6 + index,
      expectedPublicationVersion: index,
      action,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [
        scopes[0] ??
          (() => {
            throw new Error("Missing synthetic selector");
          })(),
      ],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: boundary(planned),
        effectiveUntil: boundary(expiry),
      },
      scheduleReference: action === "SchedulePublish" ? id(20) : null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: scheduledAt,
      reasonCode: "SYNTHETIC_SCHEDULE",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    };
  }
  function facts(c: ProductPublicationCommandV2, now = scheduledAt): ProductPublicationFactsV2 {
    return {
      now,
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      validation: {
        profile: "CatalogProductPublicationValidationV2",
        replacementIntentDigest: c.replacementIntentDigest,
        evidenceReference: id(40),
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
        checkedAt: now,
        validUntil: expiry,
      },
      approval: null,
      reviewReference: id(12),
      replacement: null,
    };
  }
  const draftCommand = command("Validate", 0),
    draft = planCatalogProductPublicationV2(draftCommand, null, facts(draftCommand)),
    reviewCommand = command("SubmitReview", 1),
    review = planCatalogProductPublicationV2(reviewCommand, draft, facts(reviewCommand)),
    scheduleCommand = command("SchedulePublish", 2),
    scheduled = planCatalogProductPublicationV2(scheduleCommand, review, facts(scheduleCommand)),
    candidate = { publication: scheduled, expectedAggregateVersion: 9 };
  const result = (c: ProductPublicationCommandV2): ProductPublicationWriteResultV2 => {
    // Synthetic writer: real pure lifecycle/materialization/header contracts.
    // Native SQL, Required receipts and held authority are covered separately.
    const publication = planCatalogProductPublicationV2(c, scheduled, facts(c, actual)),
      { content, successor } = createCatalogProductPublicationMaterializationV2(
        source,
        publication,
      ),
      scopeRetirementHeader = buildCatalogProductScopeRetirementHeader({
        publicationAction: "ActivateScheduled",
        publication,
        previousPublication: publication.replacementIntent.mode === "None" ? null : previous,
        observedSourceRevision: "12",
        observedSourceHeadDigest: hash("synthetic held heads"),
      });
    const report = buildCatalogProductPublicationValidationReport({
      command: c,
      publication,
      validation: facts(c, actual).validation,
      details: null,
      recordedAt: actual,
    });
    return {
      status: "Applied",
      publication,
      aggregate: successor,
      content,
      scopeRetirementHeader,
      validationReport: { status: "Recorded", report },
    };
  };
  return { candidate, result, scheduled, previous, command, facts };
}
function activator(
  execute: (command: ProductPublicationCommandV2) => Promise<ProductPublicationWriteResultV2>,
  references: {
    operation(candidate: DueProductPublicationCandidateV2): string;
    successorDraft(candidate: DueProductPublicationCandidateV2): string;
  } = {
    operation: () => id(200),
    successorDraft: () => id(201),
  },
) {
  return createProductPublicationScheduledActivatorV2({
    tenantReference: id(1),
    brandReference: id(2),
    systemActorReference: id(9),
    references,
    writer: { execute },
  });
}
function rehash<T extends { digest: string }>(value: T): T {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  return { ...body, digest: hash(body) } as T;
}
it("activates V2 with stable planned command bytes and actual synthetic execution/content/retirement time", async () => {
  const f = fixture(),
    original = canonicalizeRfc8785(f.candidate),
    commands: ProductPublicationCommandV2[] = [];
  let stored: ProductPublicationWriteResultV2 | undefined;
  const execute = vi.fn(async (c: ProductPublicationCommandV2) => {
      commands.push(c);
      if (stored) return { ...stored, status: "Replayed" as const };
      stored = f.result(c);
      return stored;
    }),
    seen: DueProductPublicationCandidateV2[] = [],
    runner = activator(execute, {
      operation(candidate) {
        seen.push(candidate);
        expect(Object.isFrozen(candidate)).toBe(true);
        return id(200);
      },
      successorDraft(candidate) {
        expect(candidate.publication.scheduleVersion).toBe(f.scheduled.scheduleVersion);
        return id(201);
      },
    });
  expect(await runner.activate(f.candidate)).toBe("Applied");
  expect(await runner.activate(structuredClone(f.candidate))).toBe("Replayed");
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[0]).toMatchObject({
    profile: "CatalogProductPublicationCommandV2",
    action: "ActivateScheduled",
    actorKind: "System",
    actorReference: id(9),
    occurredAt: planned,
    reasonCode: "SCHEDULE_DUE",
    replacementIntent: f.scheduled.replacementIntent,
    replacementIntentDigest: f.scheduled.replacementIntentDigest,
  });
  expect(stored?.publication).toMatchObject({
    occurredAt: actual,
    publishedAt: actual,
    intentDigest: hash(commands[0]),
    scheduleVersion: f.scheduled.scheduleVersion + 1,
  });
  expect(stored?.content?.sealedAt).toBe(actual);
  expect(stored?.scopeRetirementHeader.retirements[0]?.retiredAt).toBe(actual);
  expect(canonicalizeRfc8785(f.candidate)).toBe(original);
  expect(seen).toHaveLength(2);
});
it("rejects V1, malformed, foreign, stale and accessor candidates before references or writer", async () => {
  const f = fixture(),
    writer = vi.fn(async (c: ProductPublicationCommandV2) => f.result(c)),
    operation = vi.fn(() => id(200)),
    successorDraft = vi.fn(() => id(201)),
    runner = activator(writer, { operation, successorDraft });
  const legacy = Object.fromEntries(
    Object.entries(f.scheduled).filter(
      ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
    ),
  );
  const invalid = [
    { ...f.candidate, extra: true },
    { publication: f.scheduled },
    { ...f.candidate, publication: legacy },
    ...[0, 8, 9.5, 2147483647, "9"].map((expectedAggregateVersion) => ({
      ...f.candidate,
      expectedAggregateVersion,
    })),
    ...[
      { tenantReference: id(90) },
      { brandReference: id(90) },
      { state: "Draft" },
      { scheduleReference: null },
      { profile: "CatalogProductPublicationVersionV3" },
    ].map((patch) => ({ ...f.candidate, publication: { ...f.scheduled, ...patch } })),
  ];
  for (const value of invalid) await expect(runner.activate(value)).rejects.toThrow();
  const getter = vi.fn(() => f.scheduled),
    hostile = { expectedAggregateVersion: 9 };
  Object.defineProperty(hostile, "publication", { enumerable: true, get: getter });
  await expect(runner.activate(hostile)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(operation).not.toHaveBeenCalled();
  expect(successorDraft).not.toHaveBeenCalled();
  expect(writer).not.toHaveBeenCalled();
  const v1Writer = vi.fn(),
    v1Runner = createProductPublicationScheduledActivator({
      tenantReference: id(1),
      brandReference: id(2),
      systemActorReference: id(9),
      references: { operation, successorDraft },
      writer: { execute: v1Writer },
    });
  await expect(v1Runner.activate(f.candidate)).rejects.toThrow();
  expect(v1Writer).not.toHaveBeenCalled();
});
it("never treats an approval-pending V2 review as a due schedule", async () => {
  const f = fixture(),
    pendingFacts = (command: ProductPublicationCommandV2): ProductPublicationFactsV2 => {
      const facts = f.facts(command);
      return {
        ...facts,
        approval: null,
        validation: {
          ...facts.validation,
          approvalPolicy: "Required",
          checks: facts.validation.checks.map((check) => ({
            ...check,
            outcome: check.code === "ApprovalPolicy" ? "Pending" : check.outcome,
          })),
        },
      };
    },
    draftCommand = f.command("Validate", 0),
    draft = planCatalogProductPublicationV2(draftCommand, null, pendingFacts(draftCommand)),
    reviewCommand = f.command("SubmitReview", 1),
    review = planCatalogProductPublicationV2(reviewCommand, draft, pendingFacts(reviewCommand)),
    execute = vi.fn(async (command: ProductPublicationCommandV2) => f.result(command)),
    operation = vi.fn(() => id(200)),
    successorDraft = vi.fn(() => id(201));
  expect(review).toMatchObject({
    state: "InReview",
    validationDecision: "ApprovalPending",
    approvalEvidenceReference: null,
    scheduleReference: null,
  });
  await expect(
    activator(execute, { operation, successorDraft }).activate({
      publication: review,
      expectedAggregateVersion: 8,
    }),
  ).rejects.toThrow();
  expect(operation).not.toHaveBeenCalled();
  expect(successorDraft).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
it("rejects stable-reference collisions before the synthetic writer", async () => {
  const f = fixture(),
    execute = vi.fn(async (c: ProductPublicationCommandV2) => f.result(c));
  for (const n of [5, 6]) {
    await expect(
      activator(execute, { operation: () => id(200), successorDraft: () => id(n) }).activate(
        f.candidate,
      ),
    ).rejects.toThrow();
  }
  await expect(
    activator(execute, {
      operation: () => f.previous.operationReference,
      successorDraft: () => id(201),
    }).activate(f.candidate),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
const corruptions: [string, (r: ProductPublicationWriteResultV2) => unknown][] = [
  ["unknown result profile", (r) => ({ ...r, extra: true })],
  ["status", (r) => ({ ...r, status: "Unknown" })],
  [
    "missing report coverage",
    (r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== "validationReport")),
  ],
  [
    "extra report coverage field",
    (r) => ({ ...r, validationReport: { ...r.validationReport, extra: true } }),
  ],
  [
    "unknown report status",
    (r) => ({ ...r, validationReport: { status: "Unavailable", report: null } }),
  ],
  [
    "applied historical absence",
    (r) => ({ ...r, validationReport: { status: "NotRecorded", report: null } }),
  ],
  [
    "recorded missing report",
    (r) => ({ ...r, validationReport: { status: "Recorded", report: null } }),
  ],
  [
    "replayed absence with a report",
    (r) => ({
      ...r,
      status: "Replayed",
      validationReport: { status: "NotRecorded", report: r.validationReport.report },
    }),
  ],
  [
    "report digest",
    (r) => ({
      ...r,
      validationReport: {
        status: "Recorded",
        report: { ...r.validationReport.report, digest: hash("tampered report") },
      },
    }),
  ],
  [
    "transplanted report",
    (r) => {
      if (r.validationReport.status !== "Recorded") throw new Error("Missing synthetic report");
      return {
        ...r,
        validationReport: {
          status: "Recorded",
          report: rehash({ ...r.validationReport.report, operationReference: id(80) }),
        },
      };
    },
  ],
  [
    "report action transplant",
    (r) => {
      if (r.validationReport.status !== "Recorded") throw new Error("Missing synthetic report");
      return {
        ...r,
        validationReport: {
          status: "Recorded",
          report: rehash({ ...r.validationReport.report, publicationAction: "Publish" }),
        },
      };
    },
  ],
  [
    "legacy publication",
    (r) => {
      const p = Object.fromEntries(
        Object.entries(r.publication).filter(
          ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
        ),
      );
      return { ...r, publication: p };
    },
  ],
  ...(
    [
      { tenantReference: id(80) },
      { brandReference: id(80) },
      { productReference: id(80) },
      { versionReference: id(80) },
      { operationReference: id(80) },
      { actorReference: id(80) },
      { actorKind: "User" },
      { publicationVersion: 10 },
      { productAggregateVersion: 10 },
      { intentDigest: hash("wrong command") },
      { scheduleReference: id(80) },
      { scheduleVersion: 5 },
      { successorDraftVersionReference: id(80) },
      { publishedAt: planned },
      { occurredAt: planned },
      { policyReference: id(80) },
      { reviewReference: id(80) },
    ] as Partial<ProductPublicationVersionV2>[]
  ).map((patch): [string, (r: ProductPublicationWriteResultV2) => unknown] => [
    "publication " + Object.keys(patch)[0],
    (r) => ({ ...r, publication: { ...r.publication, ...patch } }),
  ]),
  ["aggregate owner", (r) => ({ ...r, aggregate: { ...r.aggregate, productReference: id(80) } })],
  ["aggregate version", (r) => ({ ...r, aggregate: { ...r.aggregate, aggregateVersion: 11 } })],
  ["aggregate time", (r) => ({ ...r, aggregate: { ...r.aggregate, updatedAt: planned } })],
  [
    "successor base",
    (r) => ({
      ...r,
      aggregate: { ...r.aggregate, draft: { ...r.aggregate.draft, baseVersionReference: id(80) } },
    }),
  ],
  ["missing content", (r) => ({ ...r, content: null })],
  ["content owner", (r) => ({ ...r, content: { ...r.content, productReference: id(80) } })],
  [
    "content operation",
    (r) => ({ ...r, content: { ...r.content, publicationOperationReference: id(80) } }),
  ],
  ["content time", (r) => ({ ...r, content: { ...r.content, sealedAt: planned } })],
  ["content source root", (r) => ({ ...r, content: { ...r.content, sourceAggregateVersion: 8 } })],
  ["missing header", (r) => ({ ...r, scopeRetirementHeader: null })],
  [
    "header operation",
    (r) => ({
      ...r,
      scopeRetirementHeader: rehash({ ...r.scopeRetirementHeader, operationReference: id(80) }),
    }),
  ],
  [
    "header snapshot",
    (r) => ({
      ...r,
      scopeRetirementHeader: rehash({
        ...r.scopeRetirementHeader,
        publicationSnapshotDigest: hash("wrong result"),
      }),
    }),
  ],
  [
    "header intent",
    (r) => ({
      ...r,
      scopeRetirementHeader: rehash({
        ...r.scopeRetirementHeader,
        publicationIntentDigest: hash("wrong command"),
      }),
    }),
  ],
  [
    "header no retirement",
    (r) => ({
      ...r,
      scopeRetirementHeader: rehash({ ...r.scopeRetirementHeader, retirements: [] }),
    }),
  ],
  [
    "header different target",
    (r) => ({
      ...r,
      scopeRetirementHeader: rehash({
        ...r.scopeRetirementHeader,
        retirements: r.scopeRetirementHeader.retirements.map((row) =>
          rehash({
            ...row,
            replacementIntent: rehash({
              ...row.replacementIntent,
              previousPublicationOperationReference: id(80),
            }),
          }),
        ),
      }),
    }),
  ],
  [
    "header time",
    (r) => ({
      ...r,
      scopeRetirementHeader: rehash({
        ...r.scopeRetirementHeader,
        recordedAt: planned,
        retirements: r.scopeRetirementHeader.retirements.map((row) =>
          rehash({ ...row, retiredAt: planned }),
        ),
      }),
    }),
  ],
];
it.each(corruptions)("refuses invalid native V2 result: %s", async (_name, corrupt) => {
  const f = fixture(),
    runner = activator(async (c) => corrupt(f.result(c)) as ProductPublicationWriteResultV2);
  await expect(runner.activate(f.candidate)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("accepts explicit historical NotRecorded only on an original replay", async () => {
  const f = fixture();
  const runner = activator(async (command) => ({
    ...f.result(command),
    status: "Replayed",
    validationReport: { status: "NotRecorded", report: null },
  }));
  expect(await runner.activate(f.candidate)).toBe("Replayed");
});
it("does not invoke an accessor inside report coverage", async () => {
  const f = fixture(),
    getter = vi.fn();
  const runner = activator(async (command) => {
    const result = f.result(command),
      coverage = { ...result.validationReport };
    Object.defineProperty(coverage, "report", { enumerable: true, get: getter });
    return { ...result, validationReport: coverage };
  });
  await expect(runner.activate(f.candidate)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(getter).not.toHaveBeenCalled();
});
it("does not invoke result accessors and preserves current writer authority failures", async () => {
  const f = fixture(),
    getter = vi.fn();
  await expect(
    activator(async (c) => {
      const r = { ...f.result(c) };
      Object.defineProperty(r, "scopeRetirementHeader", { enumerable: true, get: getter });
      return r;
    }).activate(f.candidate),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(getter).not.toHaveBeenCalled();
  await expect(
    activator(async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }).activate(f.candidate),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});

it("captures V2 reference and writer ports at construction", async () => {
  const f = fixture(),
    execute = vi.fn(async (c: ProductPublicationCommandV2) => f.result(c)),
    options = {
      tenantReference: id(1),
      brandReference: id(2),
      systemActorReference: id(9),
      references: { operation: () => id(200), successorDraft: () => id(201) },
      writer: { execute },
    },
    runner = createProductPublicationScheduledActivatorV2(options),
    injected = vi.fn(async (c: ProductPublicationCommandV2) => f.result(c));
  options.references.operation = () => id(300);
  options.references.successorDraft = () => id(301);
  options.writer.execute = injected;
  options.systemActorReference = id(99);
  expect(await runner.activate(f.candidate)).toBe("Applied");
  expect(execute).toHaveBeenCalledOnce();
  expect(injected).not.toHaveBeenCalled();
  expect(execute.mock.calls[0]?.[0]).toMatchObject({
    operationReference: id(200),
    successorDraftVersionReference: id(201),
    actorReference: id(9),
  });
  for (const patch of [
    { references: { operation: null, successorDraft: () => id(201) } },
    { references: { operation: () => id(200), successorDraft: null } },
    { writer: { execute: null } },
  ])
    expect(() =>
      createProductPublicationScheduledActivatorV2({
        ...options,
        ...patch,
      } as unknown as Parameters<typeof createProductPublicationScheduledActivatorV2>[0]),
    ).toThrow();
});

it("activates and replays a None schedule with its unchanged original intent and an explicit empty header", async () => {
  const f = fixture(true),
    commands: ProductPublicationCommandV2[] = [];
  let stored: ProductPublicationWriteResultV2 | undefined;
  const runner = activator(async (command) => {
    commands.push(command);
    if (stored) return { ...stored, status: "Replayed" };
    stored = f.result(command);
    return stored;
  });
  expect(await runner.activate(f.candidate)).toBe("Applied");
  expect(await runner.activate(f.candidate)).toBe("Replayed");
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[0]).toMatchObject({ occurredAt: planned, replacementIntent: { mode: "None" } });
  expect(stored?.publication).toMatchObject({
    occurredAt: actual,
    publishedAt: actual,
    intentDigest: hash(commands[0]),
  });
  expect(stored?.scopeRetirementHeader.retirements).toEqual([]);
  expect(stored?.scopeRetirementHeader.recordedAt).toBe(actual);
});

it("rejects a retirement row or a missing header for a None activation", async () => {
  const f = fixture(true),
    old = fixture();
  const rowBody = {
    profile: "CatalogProductExactStoreSelectorRetirementV1" as const,
    replacementIntent: parseCatalogProductScopeReplacementIntent(old.scheduled.replacementIntent),
    previousPublicationDigest: hash(old.previous),
    retiredAt: actual,
  };
  const row = { ...rowBody, digest: hash(rowBody) };
  for (const mode of ["Row", "Missing"] as const) {
    await expect(
      activator(async (command) => {
        const r = f.result(command);
        const corrupted = {
          ...r,
          scopeRetirementHeader:
            mode === "Missing" ? null : rehash({ ...r.scopeRetirementHeader, retirements: [row] }),
        };
        return corrupted as unknown as ProductPublicationWriteResultV2;
      }).activate(f.candidate),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  }
});
