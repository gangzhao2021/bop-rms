import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildMediaPublicationReadSnapshot,
  createMediaScope,
  mediaPublicationReadFields,
  parseMediaPublicationReadRequest,
  type MediaPublicationReadRequest,
  type MediaPublicationReadSnapshot,
  type MediaPublicationReferenceResult,
  type createPostgresMediaPublicationReadSource,
} from "@bop/media";
import {
  CatalogError,
  buildCatalogProductPublicationValidationReport,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  productPublicationCheckCodes,
  type ProductPublicationFactsV2,
} from "@rms/catalog";
import {
  createCurrentProductPublicationMediaSource,
  type CurrentProductPublicationMedia,
} from "./current-product-publication-media.js";
import type {
  PublicationQualificationInput,
  WarningAcknowledgementQualificationInput,
} from "./product-publication-qualification-context.js";

type OwnerOptions = Parameters<typeof createPostgresMediaPublicationReadSource>[0];
type Options = Parameters<typeof createCurrentProductPublicationMediaSource>[0];
type Tx = Options["transaction"];
const owner = vi.hoisted(() => ({
  mode: "normal",
  create: vi.fn(),
  read: vi.fn(),
  guard: vi.fn(),
  final: vi.fn(),
}));
// Controlled owning read boundary only. Actual Media contracts, full Catalog
// lifecycle/context and report parsers run; native acceptance proves the SQL.
vi.mock("@bop/media", async (original) => ({
  ...(await original<typeof import("@bop/media")>()),
  createPostgresMediaPublicationReadSource(options: OwnerOptions) {
    owner.create(options);
    return {
      async withCurrentReferences<T>(
        tx: Tx,
        request: MediaPublicationReadRequest,
        work: (value: MediaPublicationReadSnapshot, actual: Tx) => Promise<T>,
      ): Promise<T> {
        const auth = {
          request,
          action: "media.asset.access",
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ",
          requiredFields: mediaPublicationReadFields,
        } as Parameters<OwnerOptions["authority"]["holdUntilTransactionCompletes"]>[1];
        if (owner.mode === "authority-request")
          Object.assign(auth, {
            request: { ...request, originalIntentDigest: hash("different command") },
          });
        if (owner.mode === "authority-fields") Object.assign(auth, { requiredFields: [] });
        if (owner.mode === "authority-action")
          Object.assign(auth, { action: "media.asset.finalize" });
        if (owner.mode === "authority-purpose")
          Object.assign(auth, { purposeCode: "MEDIA_IMAGE_PROMOTION" });
        if (owner.mode === "authority-extra") Object.assign(auth, { ignored: true });
        const hold = () => options.authority.holdUntilTransactionCompletes(tx, auth);
        const register = () =>
          options.registerBeforeCommit(
            tx,
            async () => {
              await owner.guard();
              await hold();
            },
            () => {
              owner.final();
            },
          );
        if (owner.mode !== "no-guard") await register();
        if (owner.mode === "double-guard") {
          try {
            await register();
          } catch {
            /* hostile owner catches its failure */
          }
        }
        const lease = await hold();
        if (owner.mode === "skip") return undefined as T;
        const value = (await owner.read(
          request,
          options.clock.now(),
          lease.validUntil,
        )) as MediaPublicationReadSnapshot;
        const actual = owner.mode === "foreign" ? { query: vi.fn() } : tx;
        let result: T;
        try {
          result = await work(value, actual);
        } catch (error) {
          if (owner.mode !== "swallow") throw error;
          return undefined as T;
        }
        if (owner.mode === "repeat") {
          try {
            await work(value, tx);
          } catch {
            /* cannot unpoison */
          }
        }
        return owner.mode === "substitute" ? ({} as T) : result;
      },
    };
  },
}));
const id = (n: number) => "01902445-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  plus = (value: string, ms: number) => new Date(Date.parse(value) + ms).toISOString(),
  boundary = (value: string) => ({
    instant: value,
    localDateTime: value.slice(0, -1),
    utcOffsetMinutes: 0,
  });
function publication(count = 1): PublicationQualificationInput {
  const aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_MEDIA_PRODUCT",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 7,
      createdAt: at,
      createdByActorReference: id(3),
      updatedAt: at,
      draft: {
        versionReference: id(6),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic media source" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: {},
          localizedDescriptions: {},
          preparationNotes: {},
          tagReferences: [],
          attributeValues: [],
          media: Array.from({ length: count }, (_, n) => ({
            mediaReference: id(100 + n),
            assetReference: id(200 + n),
            assetVersionReference: id(300 + n),
            role: n === 0 ? "Primary" : "Gallery",
            altText: { "en-CA": "Synthetic image" },
            sortOrder: n,
            cropReference: null,
            focusReference: null,
          })),
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    none = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(8),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 7,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [
        { level: "Store", reference: id(30), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
      ],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: boundary(plus(at, 3600000)),
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_MEDIA_SOURCE",
      replacementIntent: { ...none, digest: hash(none) },
      replacementIntentDigest: hash(none),
    });
  return { command, aggregate, current: null, content: null, observedAt: at };
}
function facts(input: PublicationQualificationInput, warning = false): ProductPublicationFactsV2 {
  const c = input.command;
  return {
    now: input.observedAt,
    productAggregateVersion: input.aggregate.aggregateVersion,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    approval: null,
    reviewReference: c.action === "SubmitReview" ? id(21) : null,
    replacement: null,
    validation: {
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: c.replacementIntentDigest,
      evidenceReference: id(50 + c.expectedPublicationVersion),
      productAggregateVersion: input.aggregate.aggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(20),
      policyVersion: 1,
      approvalPolicy: warning ? "Required" : "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          warning && code === "ApprovalPolicy"
            ? "Pending"
            : warning && code === "ChangeImpact"
              ? "Warning"
              : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: input.observedAt,
      validUntil: plus(input.observedAt, 3000),
    },
  };
}
function activation(): PublicationQualificationInput {
  let input = publication();
  for (const action of ["SubmitReview", "SchedulePublish", "ActivateScheduled"] as const) {
    const current = planCatalogProductPublicationV2(input.command, input.current, facts(input)),
      aggregate = parseProductAggregate({
        ...input.aggregate,
        aggregateVersion: input.aggregate.aggregateVersion + 1,
      }),
      occurredAt =
        action === "ActivateScheduled" ? input.command.effectivePeriod.effectiveFrom.instant : at,
      command = parseProductPublicationCommandV2({
        ...input.command,
        action,
        operationReference: id(70 + current.publicationVersion),
        expectedProductAggregateVersion: aggregate.aggregateVersion,
        expectedPublicationVersion: current.publicationVersion,
        actorKind: action === "ActivateScheduled" ? "System" : "User",
        actorReference: action === "ActivateScheduled" ? id(90) : id(3),
        occurredAt,
        scheduleReference: action === "SubmitReview" ? null : id(22),
        successorDraftVersionReference: action === "ActivateScheduled" ? id(23) : null,
      });
    input = {
      command,
      aggregate,
      current,
      content: null,
      observedAt: action === "ActivateScheduled" ? plus(occurredAt, 10000) : at,
    };
  }
  return input;
}
function acknowledgement(): WarningAcknowledgementQualificationInput {
  const input = publication(),
    f = facts(input, true),
    current = planCatalogProductPublicationV2(input.command, null, f),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SYNTHETIC_REFERENCE_GAP",
          outcome: "Warning",
          subjectReference: id(80),
          reasonCode: "SYNTHETIC",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC_REFERENCE",
          sourceDigest: hash("controlled source"),
          generation: "1",
          relevantReferenceDigest: hash("controlled relevant references"),
          observedAt: at,
          validUntil: plus(at, 3000),
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: input.command,
      publication: current,
      validation: f.validation,
      details,
      recordedAt: at,
    }),
    aggregate = parseProductAggregate({ ...input.aggregate, aggregateVersion: 11 }),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(60),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 11,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_REVIEW",
      occurredAt: humanAt,
    });
  return {
    command,
    aggregate,
    current,
    report,
    observedAt: plus(humanAt, 10),
    validUntil: plus(humanAt, 2000),
  };
}
function snapshot(
  request: MediaPublicationReadRequest,
  observedAt: string,
  validUntil: string,
  reason?: Extract<MediaPublicationReferenceResult, { status: "Unavailable" }>["reason"],
) {
  return buildMediaPublicationReadSnapshot({
    request,
    observedAt,
    validUntil,
    references: request.references.map((r, n) => {
      if (reason) return { ...r, status: "Unavailable", reason };
      const renditions = Array.from({ length: 6 }, (_, i) => ({
        contentType: i % 2 === 0 ? "image/jpeg" : "image/webp",
        width: i < 2 ? 320 : i < 4 ? 640 : 1280,
        height: i < 2 ? 160 : i < 4 ? 320 : 640,
        byteSize: 256,
        checksum: hash({ asset: r.assetReference, i }),
        objectEvidenceReference: id(1000 + n * 100 + i * 2),
        providerObjectVersion: id(1001 + n * 100 + i * 2),
      }));
      const representative = renditions[4];
      if (!representative) throw Error("Missing synthetic representative");
      return {
        ...r,
        status: "Ready",
        reason: "Ready",
        asset: {
          assetId: r.assetReference,
          purpose: "PRODUCT_IMAGE",
          scope: request.scope,
          mediaKind: "Image",
          ownerType: "PRODUCT",
          ownerReference: id(999),
          classification: "Public",
        },
        assetVersion: {
          assetVersionId: r.assetVersionReference,
          assetId: r.assetReference,
          version: 2,
          objectEvidenceReference: representative.objectEvidenceReference,
          providerObjectVersion: representative.providerObjectVersion,
          byteSize: representative.byteSize,
          checksum: representative.checksum,
          contentType: representative.contentType,
          checkState: "Clean",
          readinessState: "Ready",
          createdAt: at,
        },
        renditions,
        provenanceDigest: hash({ asset: r.assetReference, version: r.assetVersionReference }),
      } as unknown as MediaPublicationReferenceResult;
    }),
  });
}
function fixture(input = publication(), readScope?: OwnerOptions["scope"]) {
  let time = input.observedAt,
    denied = false,
    until = plus(input.observedAt, 2000);
  const query = vi.fn(async () => ({ rows: [] })),
    tx: Tx = { query },
    guards: { guard: () => Promise<void>; final: () => void }[] = [],
    hold = vi.fn<Options["authority"]["holdUntilTransactionCompletes"]>(async (_tx, request) => {
      if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return { observedAt: request.requestObservedAt, validUntil: until };
    }),
    options: Options = {
      transaction: tx,
      scope:
        readScope ??
        createMediaScope({
          kind: "Brand",
          brandReference: id(2),
          storeReference: null,
        } as OwnerOptions["scope"]),
      clock: { now: () => time },
      authority: { holdUntilTransactionCompletes: hold },
      registerBeforeCommit: vi.fn(async (actual, guard, final) => {
        expect(actual).toBe(tx);
        guards.push({ guard, final });
      }),
    },
    source = createCurrentProductPublicationMediaSource(options),
    work = vi.fn(async (value: CurrentProductPublicationMedia) => value),
    validUntil = plus(input.observedAt, 2000);
  owner.read.mockImplementation(snapshot);
  return {
    input,
    options,
    source,
    tx,
    query,
    guards,
    hold,
    work,
    validUntil,
    setTime: (value: string) => {
      time = value;
    },
    setUntil: (value: string) => {
      until = value;
    },
    deny: () => {
      denied = true;
    },
    run: () => source.withPublication(input, validUntil, work),
    async commit() {
      for (const g of guards) await g.guard();
      for (const g of guards) g.final();
    },
  };
}
beforeEach(() => {
  owner.mode = "normal";
  owner.create.mockReset();
  owner.read.mockReset();
  owner.guard.mockReset();
  owner.final.mockReset();
});

it("uses the actual pinned read, exact full original authority and safe evidence without denying a different same-Brand owner", async () => {
  const f = fixture(),
    result = await f.run();
  expect(result.check).toEqual({ code: "MediaReady", outcome: "Pass" });
  expect(result.findings).toEqual([]);
  expect(result.originalIntentDigest).toBe(hash(f.input.command));
  expect(result.contentDigest).toBe(f.input.command.contentDigest);
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toMatchObject({
    sourceCode: "MEDIA_READINESS",
    generation: null,
    validUntil: f.validUntil,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.sources)).toBe(true);
  await f.commit();
  expect(f.hold).toHaveBeenCalledTimes(2);
  expect(f.hold).toHaveBeenLastCalledWith(
    f.tx,
    expect.objectContaining({
      command: f.input.command,
      commandPurposeCode: f.input.command.purposeCode,
      originalIntentDigest: hash(f.input.command),
      requestObservedAt: at,
      requestValidUntil: f.validUntil,
      action: "media.asset.access",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ",
      requiredFields: mediaPublicationReadFields,
      request: expect.objectContaining({
        profile: "MediaPublicationReadRequestV1",
        intentKind: "PublicationV2",
        actorKind: "User",
        aggregateSnapshotDigest: hash(f.input.aggregate),
      }),
    }),
  );
  expect(owner.guard).toHaveBeenCalledTimes(1);
  expect(owner.final).toHaveBeenCalledTimes(1);
});
it("admits actual empty references under current access without claiming RequiredMediaPresence", async () => {
  const f = fixture(publication(0)),
    result = await f.run();
  expect(result.check).toEqual({ code: "MediaReady", outcome: "Pass" });
  expect(result).not.toHaveProperty("requiredMediaPresence");
  expect(owner.read).toHaveBeenCalledTimes(1);
  expect(f.hold).toHaveBeenCalledTimes(1);
  expect(owner.read.mock.calls[0]?.[0].references).toEqual([]);
  await f.commit();
});
function storeScope(reference = id(30)) {
  return createMediaScope({
    kind: "Store",
    brandReference: id(2),
    storeReference: reference,
  } as OwnerOptions["scope"]);
}
it("accepts Store media only for the same explicit Store, retaining channel and order filters", async () => {
  const input = publication(),
    command = parseProductPublicationCommandV2({
      ...input.command,
      scopeSet: [
        { level: "Store", reference: id(30), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
        { level: "Store", reference: id(30), channelCodes: ["POS"], orderTypeCodes: ["DINE_IN"] },
      ],
    }),
    f = fixture({ ...input, command }, storeScope()),
    result = await f.run();
  expect(result.check).toEqual({ code: "MediaReady", outcome: "Pass" });
  expect(f.hold).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      command,
      request: expect.objectContaining({ scope: storeScope() }),
    }),
  );
  await f.commit();
});
it.each([
  {
    name: "Brand",
    scopes: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
  },
  {
    name: "different Store",
    scopes: [{ level: "Store", reference: id(31), channelCodes: [], orderTypeCodes: [] }],
  },
  {
    name: "multiple Stores",
    scopes: [
      { level: "Store", reference: id(30), channelCodes: [], orderTypeCodes: [] },
      { level: "Store", reference: id(31), channelCodes: [], orderTypeCodes: [] },
    ],
  },
  {
    name: "Region",
    scopes: [{ level: "Region", reference: id(32), channelCodes: [], orderTypeCodes: [] }],
  },
])(
  "refuses Store media for $name publication coverage before any owning read",
  async ({ scopes }) => {
    const input = publication(),
      command = parseProductPublicationCommandV2({ ...input.command, scopeSet: scopes }),
      f = fixture({ ...input, command }, storeScope());
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(owner.create).not.toHaveBeenCalled();
    expect(owner.read).not.toHaveBeenCalled();
    expect(f.work).not.toHaveBeenCalled();
    expect(f.guards).toHaveLength(1);
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it.each([true, false])(
  "binds Ack Store coverage to the actual current head (matching=%s)",
  async (matching) => {
    const input = acknowledgement(),
      f = fixture(publication(), storeScope(matching ? id(30) : id(31)));
    f.setTime(input.observedAt);
    f.setUntil(input.validUntil);
    expect(input.current.scopeSet.every((s) => s.level === "Store" && s.reference === id(30))).toBe(
      true,
    );
    expect(input.command).not.toHaveProperty("scopeSet");
    const run = f.source.withAcknowledgement(input, f.work);
    if (matching) {
      expect((await run).check).toEqual({ code: "MediaReady", outcome: "Pass" });
      expect(f.hold).toHaveBeenCalledWith(
        f.tx,
        expect.objectContaining({
          command: input.command,
          request: expect.objectContaining({
            intentKind: "WarningAcknowledgementV1",
            scope: storeScope(),
          }),
        }),
      );
      await f.commit();
    } else {
      await expect(run).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      expect(owner.read).not.toHaveBeenCalled();
      expect(f.work).not.toHaveBeenCalled();
      await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    }
  },
);
it.each([
  ["NotFound", "MEDIA_REFERENCE_NOT_FOUND"],
  ["NotReady", "MEDIA_REFERENCE_NOT_READY"],
  ["UnsupportedMedia", "MEDIA_KIND_UNSUPPORTED"],
  ["UnsupportedAdjustment", "MEDIA_ADJUSTMENT_UNSUPPORTED"],
] as const)(
  "maps proved owning %s to specific HardError with the actual pin",
  async (reason, reasonCode) => {
    const f = fixture();
    owner.read.mockImplementation((request, observedAt, validUntil) =>
      snapshot(request, observedAt, validUntil, reason),
    );
    const result = await f.run();
    expect(result.check).toEqual({ code: "MediaReady", outcome: "HardError" });
    expect(result.findings).toEqual([
      expect.objectContaining({
        checkCode: "MediaReady",
        outcome: "HardError",
        subjectReference: id(100),
        reasonCode,
        references: [
          expect.objectContaining({ resourceReference: id(200), versionReference: id(300) }),
        ],
      }),
    ]);
    await f.commit();
  },
);
it.each(["cropReference", "focusReference"] as const)(
  "preserves unsupported %s for the owning negative assessment",
  async (key) => {
    const initial = publication(),
      editor = initial.aggregate.draft.editorContent;
    if (!editor) throw Error("Missing complete fixture");
    const aggregate = parseProductAggregate({
        ...initial.aggregate,
        draft: {
          ...initial.aggregate.draft,
          editorContent: { ...editor, media: editor.media.map((r) => ({ ...r, [key]: id(700) })) },
        },
      }),
      identity = deriveCatalogProductPublicationContentIdentity(aggregate),
      input = {
        ...initial,
        aggregate,
        command: parseProductPublicationCommandV2({
          ...initial.command,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
        }),
      },
      f = fixture(input);
    owner.read.mockImplementation((request, observedAt, validUntil) => {
      expect(request.references[0][key]).toBe(id(700));
      return snapshot(request, observedAt, validUntil, "UnsupportedAdjustment");
    });
    expect((await f.run()).check.outcome).toBe("HardError");
  },
);
it("retains every independent pin finding", async () => {
  const f = fixture(publication(2));
  owner.read.mockImplementation((request, observedAt, validUntil) =>
    snapshot(request, observedAt, validUntil, "NotReady"),
  );
  const result = await f.run();
  expect(result.findings.map((v) => v.subjectReference)).toEqual([id(100), id(101)]);
  expect(result.findings.map((v) => v.references[0]?.versionReference)).toEqual([id(300), id(301)]);
});
it("keeps semantic media evidence stable across operation/root/observation changes but changes it for a missing pin", async () => {
  const first = fixture(),
    a = await first.run(),
    input = publication(),
    aggregate = parseProductAggregate({ ...input.aggregate, aggregateVersion: 9 }),
    next = {
      ...input,
      aggregate,
      command: parseProductPublicationCommandV2({
        ...input.command,
        operationReference: id(19),
        expectedProductAggregateVersion: 9,
        occurredAt: plus(at, 500),
      }),
      observedAt: plus(at, 500),
    },
    second = fixture(next),
    b = await second.run();
  expect(a.sources[0]?.relevantReferenceDigest).toBe(b.sources[0]?.relevantReferenceDigest);
  expect(a.sources[0]?.sourceDigest).not.toBe(b.sources[0]?.sourceDigest);
  const third = fixture(next);
  owner.read.mockImplementation((request, observedAt, validUntil) =>
    snapshot(request, observedAt, validUntil, "NotFound"),
  );
  expect((await third.run()).sources[0]?.relevantReferenceDigest).not.toBe(
    b.sources[0]?.relevantReferenceDigest,
  );
});
it("keeps an independent Ack with an expired displayed report and its own original current lease", async () => {
  const input = acknowledgement(),
    f = fixture();
  f.setTime(input.observedAt);
  f.setUntil(input.validUntil);
  const result = await f.source.withAcknowledgement(input, f.work);
  expect(input.report.validation.validUntil < input.observedAt).toBe(true);
  expect(result.originalIntentDigest).toBe(hash(input.command));
  expect(result.validUntil).toBe(input.validUntil);
  expect(f.hold).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      command: input.command,
      commandPurposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      request: expect.objectContaining({
        intentKind: "WarningAcknowledgementV1",
        actorKind: "User",
        operationReference: input.command.operationReference,
      }),
    }),
  );
  await f.commit();
});
it("preserves actual delayed System ActivateScheduled and its original full command", async () => {
  const input = activation(),
    f = fixture(input),
    result = await f.run();
  expect(input.command.occurredAt < input.observedAt).toBe(true);
  expect(result.originalIntentDigest).toBe(hash(input.command));
  expect(f.hold).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      command: expect.objectContaining({
        action: "ActivateScheduled",
        actorKind: "System",
        actorReference: id(90),
      }),
      request: expect.objectContaining({
        actorKind: "System",
        originalIntentDigest: hash(input.command),
      }),
    }),
  );
  await f.commit();
});
it("uses the earliest actual authority lease and rejects final exact expiry", async () => {
  const f = fixture();
  f.setUntil(plus(at, 1000));
  expect((await f.run()).validUntil).toBe(plus(at, 1000));
  for (const g of f.guards) await g.guard();
  f.setTime(plus(at, 1000));
  expect(() => f.guards[0]?.final()).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});
it("rejects later authority withdrawal and poisons final commit", async () => {
  const f = fixture();
  await f.run();
  f.deny();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(() => f.guards[0]?.final()).toThrow();
});
it.each([
  "skip",
  "repeat",
  "foreign",
  "substitute",
  "no-guard",
  "double-guard",
  "authority-request",
  "authority-fields",
  "authority-action",
  "authority-purpose",
  "authority-extra",
])("rejects owning boundary %s without consumer facts or a reusable outer guard", async (mode) => {
  const f = fixture();
  owner.mode = mode;
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("does not treat an owning read failure as missing media", async () => {
  const f = fixture();
  owner.read.mockRejectedValue(new Error("private SQL detail"));
  await expect(f.run()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    message: "catalog is unavailable",
  });
  expect(f.work).not.toHaveBeenCalled();
});
it("retains a swallowed consumer failure as an outer transaction poison", async () => {
  const f = fixture();
  owner.mode = "swallow";
  f.work.mockRejectedValue(new Error("consumer failure"));
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["digest", "request", "scope"])(
  "rejects malformed / mismatched owning %s instead of returning a readiness fact",
  async (mode) => {
    const f = fixture();
    owner.read.mockImplementation((request, observedAt, validUntil) => {
      if (mode === "digest")
        return { ...snapshot(request, observedAt, validUntil), digest: hash("wrong") };
      const changed = parseMediaPublicationReadRequest({
        ...request,
        ...(mode === "scope"
          ? { scope: { ...request.scope, brandReference: id(999) } }
          : { replacementIntentDigest: hash("wrong target") }),
      });
      return snapshot(changed, observedAt, validUntil);
    });
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.work).not.toHaveBeenCalled();
  },
);
it("registers poison before exposing a malformed context", async () => {
  const f = fixture(),
    input = { ...f.input, command: { ...f.input.command, contentDigest: hash("wrong content") } };
  await expect(f.source.withPublication(input, f.validUntil, f.work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.guards).toHaveLength(1);
  expect(owner.create).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("cannot equate missing complete editor content with an empty reference set", async () => {
  const f = fixture(),
    { editorContent: omitted, ...draft } = f.input.aggregate.draft;
  expect(omitted).toBeDefined();
  const aggregate = parseProductAggregate({ ...f.input.aggregate, draft }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    command = parseProductPublicationCommandV2({
      ...f.input.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    });
  await expect(
    f.source.withPublication({ ...f.input, aggregate, command }, f.validUntil, f.work),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(owner.read).not.toHaveBeenCalled();
});
it("captures mutable command/content and configured ports before yielding", async () => {
  const input: PublicationQualificationInput = JSON.parse(JSON.stringify(publication())),
    f = fixture(input),
    original = hash(input.command),
    running = f.run();
  Object.assign(input.command, { operationReference: id(999) });
  const editor = input.aggregate.draft.editorContent;
  if (!editor) throw Error("Missing complete fixture");
  Object.assign(editor.media[0] ?? {}, { assetReference: id(999) });
  Object.assign(f.options.authority, {
    holdUntilTransactionCompletes: vi.fn(() => {
      throw Error("replaced authority");
    }),
  });
  Object.assign(f.options.clock, { now: () => "invalid" });
  Object.assign(f.options, {
    registerBeforeCommit: vi.fn(() => {
      throw Error("replaced registration");
    }),
  });
  const result = await running;
  expect(result.originalIntentDigest).toBe(original);
  expect(owner.read.mock.calls[0]?.[0].references[0].assetReference).toBe(id(200));
  expect(f.hold).toHaveBeenCalledTimes(1);
  await f.commit();
});
it("poisons a caught same-source reentry", async () => {
  const f = fixture();
  f.work.mockImplementation(async (value) => {
    try {
      await f.run();
    } catch {
      /* caller cannot recover eligibility */
    }
    return value;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("refuses swapped tx.query through final commit", async () => {
  const f = fixture();
  await f.run();
  Object.assign(f.tx, { query: vi.fn() });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("rejects expiry after consumer work and never renews the original lease", async () => {
  const f = fixture();
  f.work.mockImplementation(async (value) => {
    f.setTime(f.validUntil);
    return value;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["reverse-clock", "invalid-clock", "renewed-lease", "moved-observation"])(
  "rejects %s rather than refreshing source currentness",
  async (mode) => {
    const f = fixture();
    if (mode === "reverse-clock") f.setTime(plus(at, -1));
    if (mode === "invalid-clock") f.setTime("invalid");
    if (mode === "renewed-lease") f.setUntil(plus(at, 5000));
    if (mode === "moved-observation")
      f.hold.mockResolvedValue({ observedAt: plus(at, 1), validUntil: f.validUntil });
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it.each(["before", "pending", "repeat"])(
  "requires the real child async guard to finish exactly once before final (%s)",
  async (mode) => {
    const f = fixture();
    await f.run();
    const g = f.guards[0];
    if (!g) throw Error("Missing host guard");
    if (mode === "before") expect(() => g.final()).toThrow();
    else if (mode === "repeat") {
      await g.guard();
      await expect(g.guard()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    } else {
      let release: (() => void) | undefined;
      owner.guard.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const pending = g.guard();
      expect(() => g.final()).toThrow();
      if (!release) throw Error("Async guard did not start");
      release();
      await expect(pending).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    }
  },
);
