import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createIdentityActor } from "@bop/identity";
import {
  createBrand,
  createBrandAdministrationContext,
  createPlatformBrandTemplateRevision,
  parsePlatformBrandTemplateSave,
  parsePlatformBrandTemplateReceipt,
  platformBrandTemplateIntentDigest,
} from "@bop/tenant";
import {
  buildPlatformPublishingSource,
  parsePlatformPublishingOriginal,
  parsePlatformPublishingReceipt,
  platformPublishingIntentDigest,
} from "../contracts/platform-publishing-source.js";
import {
  createPostgresPlatformTemplateBrandReferenceSource,
  type PlatformTemplateBrandReferenceSourceOptions,
} from "../infrastructure/persistence/platform-template-brand-reference-source.js";
const id = (n: number) => `01904000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const created = "2026-10-06T11:00:00.000Z",
  at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
const hash = (value: unknown) => `sha256:${sha256Hex(canonicalizeRfc8785(value))}`;
const codec = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (text: string) => `sha256:${sha256Hex(text)}`,
};
function material(
  n = 10,
  period: { effectiveFrom?: string; effectiveUntil?: string | null } = {},
  versionReference = id(n + 1),
) {
  const original = parsePlatformBrandTemplateSave({
    profile: "PlatformBrandTemplateSaveV1",
    kind: "Platform",
    actorReference: id(8),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    operationReference: id(n + 2),
    templateReference: null,
    expectedHead: null,
    content: {
      code: `TEMPLATE_${n}`,
      name: "Controlled immutable template",
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA"],
      overrideAllowedFieldCodes: ["CONTACT"],
      hardRequirementFieldCodes: ["SECURITY.REAUTH"],
      effectiveFrom: created,
      effectiveUntil: null,
      reasonCode: "INITIAL_CONFIGURATION",
      ...period,
    },
  });
  const revision = createPlatformBrandTemplateRevision(
    {
      profile: "PlatformBrandTemplateRevisionV1",
      templateReference: id(n),
      templateVersionReference: versionReference,
      revision: 1,
      recordKind: "AuthoredContent",
      content: original.content,
      supersedesVersionReference: null,
      authoredByReference: id(8),
      operationReference: id(n + 2),
      auditReference: id(n + 3),
      createdAt: created,
      recordedAt: created,
      dataClassification: "ConfigurationMetadata",
    },
    codec,
  );
  const receipt = parsePlatformBrandTemplateReceipt(
    {
      profile: "PlatformBrandTemplateOperationV1",
      kind: "Platform",
      actorReference: id(8),
      purposeCode: "PLATFORM_BRAND_TEMPLATE",
      operationReference: id(n + 2),
      intentDigest: platformBrandTemplateIntentDigest(original, codec),
      originalCommand: original,
      outcome: "Committed",
      snapshot: revision,
      auditReference: id(n + 3),
      occurredAt: created,
      dataClassification: "ConfigurationMetadata",
    },
    codec,
  );
  return { revision, receipt };
}
function publication(
  m: ReturnType<typeof material>,
  author = id(8),
  contentDigest: string = m.revision.contentDigest,
) {
  const ref = (n: number) =>
    id(Number.parseInt(m.revision.templateReference.slice(-12), 16) * 100 + n);
  const version = m.revision.templateVersionReference,
    family = m.revision.templateReference,
    scope = { kind: "Platform", brandReference: null, storeReference: null },
    publishedAt = "2026-10-06T11:59:00.000Z",
    reviewUntil = "2026-10-06T11:59:30.000Z";
  const current = {
    lifecycleId: ref(80),
    familyReference: family,
    configurationType: "PLATFORM_BRAND_TEMPLATE",
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    snapshotReference: version,
    snapshotDigest: contentDigest,
    scope,
    version: 3,
    state: "Approved",
    validationEvidenceReference: ref(84),
    approvalEvidenceReference: ref(85),
    createdAt: created,
    changedAt: "2026-10-06T11:58:00.000Z",
    authoredActorReference: author,
    submittedActorReference: id(81),
    reviewValidUntil: reviewUntil,
  };
  const command = {
    profile: "PlatformPublishingCommandV1",
    operation: "Publish",
    operationReference: ref(86),
    currentActorReference: id(83),
    expectedVersion: 3,
    current,
    next: { ...current, version: 4, state: "Published", changedAt: publishedAt },
    validationEvidence: {
      evidenceReference: ref(84),
      snapshotReference: version,
      snapshotDigest: contentDigest,
      scope,
      result: "Pass",
      checkedAt: "2026-10-06T11:56:00.000Z",
      validUntil: reviewUntil,
      checkCodes: ["TEMPLATE_POLICY_VALID"],
    },
    approvalEvidence: {
      evidenceReference: ref(85),
      reviewLifecycleId: ref(80),
      reviewVersion: 2,
      snapshotReference: version,
      snapshotDigest: contentDigest,
      scope,
      decision: "Accepted",
      approvedActorReference: id(82),
      authoredActorReference: author,
      submittedActorReference: id(81),
      approvedAt: "2026-10-06T11:58:00.000Z",
      validUntil: reviewUntil,
    },
    release: {
      releaseId: ref(87),
      familyReference: family,
      configurationType: "PLATFORM_BRAND_TEMPLATE",
      purposeCode: "PLATFORM_BRAND_TEMPLATE",
      snapshotReference: version,
      snapshotDigest: contentDigest,
      scope,
      sequence: 1,
      sourceLifecycleId: ref(80),
      kind: "Publish",
      previousReleaseId: null,
      createdAt: publishedAt,
    },
    previousRelease: null,
    rollbackTarget: null,
    occurredAt: publishedAt,
  };
  const original = parsePlatformPublishingOriginal({
    profile: "PlatformPublishingOriginalV1",
    scope: { kind: "Platform", actorReference: id(83), purposeCode: "PLATFORM_BRAND_TEMPLATE" },
    request: {
      profile: "PlatformPublishingRequestV1",
      operation: "Publish",
      operationReference: ref(86),
      templateReference: family,
      templateVersionReference: version,
      contentDigest,
      templateSourceDigest: m.revision.sourceDigest,
      expectedLifecycle: {
        lifecycleReference: ref(80),
        version: 3,
        sourceDigest: hash("controlled prior"),
      },
      reviewValidUntil: null,
      reasonCode: "APPROVED_PUBLICATION",
    },
  });
  const source = buildPlatformPublishingSource({
    profile: "PlatformPublishingSourceV1",
    sequence: 4,
    templateSourceDigest: m.revision.sourceDigest,
    originalCommand: original,
    intentDigest: platformPublishingIntentDigest(original),
    command,
    auditReference: ref(88),
  });
  return parsePlatformPublishingReceipt({
    profile: "PlatformPublishingReceiptV1",
    ...original.scope,
    operationReference: ref(86),
    intentDigest: platformPublishingIntentDigest(original),
    outcome: "Committed",
    originalCommand: original,
    source,
    auditReference: ref(88),
    occurredAt: publishedAt,
  });
}
function head(m: ReturnType<typeof material>, receipt = publication(m)) {
  return {
    family_reference: m.revision.templateReference,
    sequence: 4,
    release_active: true,
    selected_receipt_text: canonicalizeRfc8785(receipt),
    selected_receipt_digest: hash(receipt),
    release_receipt_text: canonicalizeRfc8785(receipt),
    release_receipt_digest: hash(receipt),
  };
}
/** Actual Tenant content holder and both owner receipt/hash decoders. Only SQL
 * transport and current administrative IAM are controlled; locks/ACL are native. */
function fixture(initial = material()) {
  const state = {
    time: at,
    deadline: until,
    allowed: true,
    lifecycle: "Draft",
    actor: id(1),
    brand: id(2),
    isolation: "read committed",
    rows: [head(initial)] as unknown[],
    templates: new Map([[String(initial.revision.templateVersionReference), initial]]),
    onHold: undefined as undefined | (() => Promise<void>),
    onFence: undefined as undefined | (() => void),
    onListFence: undefined as undefined | (() => void),
    corruptTemplate: false,
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    if (sql.includes("transaction_isolation"))
      return {
        rows: [
          sql.includes("isolation_level")
            ? { isolation_level: state.isolation }
            : { isolation: state.isolation },
        ],
      };
    if (sql.includes("platform_brand_template_reference_read")) {
      const m = state.templates.get(String(values[2]));
      if (!m) return { rows: [] };
      const s = m.revision,
        o = m.receipt;
      return {
        rows: [
          {
            revision_row: {
              template_id: s.templateReference,
              version_id: s.templateVersionReference,
              revision: String(s.revision),
              code: s.content.code,
              actor_id: s.authoredByReference,
              operation_id: s.operationReference,
              audit_id: s.auditReference,
              content_digest: s.contentDigest,
              source_digest: s.sourceDigest,
              snapshot_json: state.corruptTemplate
                ? { ...s, content: { ...s.content, name: "Tampered" } }
                : s,
              precise: true,
            },
            operation_row: {
              actor_id: o.actorReference,
              purpose_code: o.purposeCode,
              operation_id: o.operationReference,
              intent_digest: o.intentDigest,
              receipt_json: o,
              receipt_digest: hash(o),
              precise: true,
            },
          },
        ],
      };
    }
    if (sql.includes("brand_template_publication_hold")) {
      state.onFence?.();
      return { rows: [] };
    }
    if (sql.includes("brand_template_publication_read")) return { rows: state.rows };
    if (sql.includes("brand_template_publication_list")) {
      if (values[4] === true) state.onListFence?.();
      return { rows: state.rows };
    }
    return { rows: [] };
  });
  const tx: PlatformTemplateBrandReferenceSourceOptions["transaction"] = { query };
  const authority = {
    holdUntilTransactionCompletes: vi.fn(
      async (
        actual: PlatformTemplateBrandReferenceSourceOptions["transaction"],
        input: Parameters<
          PlatformTemplateBrandReferenceSourceOptions["authority"]["holdUntilTransactionCompletes"]
        >[1],
      ) => {
        expect(actual).toBe(tx);
        expect(input.permission).toBe("organization.manage");
        expect(input.purposeCode).toBe("BRAND_ADMINISTRATION");
        await state.onHold?.();
        if (!state.allowed) throw new Error("Controlled permission denial");
        const actor = createIdentityActor({
          actorType: "User",
          actorReference: state.actor,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt: created,
          recentMfaAt: null,
        });
        const brand = createBrand({
          brandReference: state.brand,
          code: "SYNTHETIC",
          displayName: "Synthetic Brand",
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          lifecycle: state.lifecycle,
          version: 1,
          createdAt: created,
          updatedAt: created,
        });
        return {
          administrationContext: createBrandAdministrationContext(actor, brand, state.time),
          validUntil: state.deadline,
        };
      },
    ),
  };
  const register = vi.fn(
    async (
      actual: PlatformTemplateBrandReferenceSourceOptions["transaction"],
      g: () => Promise<void>,
      f: () => void,
    ) => {
      expect(actual).toBe(tx);
      guard = g;
      final = f;
    },
  );
  const options: PlatformTemplateBrandReferenceSourceOptions = {
    transaction: tx,
    scope: { tenantReference: id(2), brandReference: id(2), actorReference: id(1) },
    clock: { now: () => state.time },
    originalObservedAt: at,
    originalValidUntil: until,
    authority,
    registerBeforeCommit: register,
  };
  const source = createPostgresPlatformTemplateBrandReferenceSource(options);
  return {
    source,
    options,
    state,
    query,
    tx,
    authority,
    register,
    initial,
    guard: async () => {
      if (!guard) throw new Error("Missing guard");
      await guard();
    },
    final: () => {
      if (!final) throw new Error("Missing final");
      final();
    },
  };
}
it.each(["Draft", "Active", "Suspended", "Archived"])(
  "qualifies real immutable Published material for %s administrative Brand",
  async (lifecycle) => {
    const f = fixture();
    f.state.lifecycle = lifecycle;
    const packet = await f.source.current({
      templateVersionReference: f.initial.revision.templateVersionReference,
    });
    expect(packet.reference).toMatchObject({
      template: f.initial.revision,
      releaseReference: id(1087),
      releaseSequence: 1,
    });
    // A previous review deadline is not the Published template's business expiry.
    expect(packet.reference?.publishedAt).toBe("2026-10-06T11:59:00.000Z");
    expect(packet.validUntil).toBe(until);
    const sql = f.query.mock.calls.map(([q]) => q);
    expect(sql.findIndex((q) => q.includes("platform_brand_template_reference_read"))).toBeLessThan(
      sql.findIndex((q) => q.includes("brand_template_publication_hold")),
    );
    expect(sql.some((q) => q.includes("bop.platform_actor_id"))).toBe(false);
    await f.guard();
    f.final();
    f.state.time = "2026-10-07T00:00:00.000Z";
    expect(() => f.source.assertFinalized()).not.toThrow();
  },
);
it.each(["unpublished", "absentHead", "absentVersion", "replaced", "expired", "future"])(
  "returns guarded absence for %s exact reference",
  async (mode) => {
    const initial = material(
        10,
        mode === "expired"
          ? { effectiveUntil: at }
          : mode === "future"
            ? { effectiveFrom: "2026-10-06T12:00:00.100Z" }
            : {},
      ),
      f = fixture(initial);
    if (mode === "unpublished") f.state.rows = [{ ...head(initial), release_active: false }];
    if (mode === "absentHead") f.state.rows = [];
    if (mode === "absentVersion") f.state.templates.clear();
    if (mode === "replaced") f.state.rows = [head(material(10, {}, id(70)))];
    const packet = await f.source.current({
      templateVersionReference: initial.revision.templateVersionReference,
    });
    expect(packet.reference).toBeNull();
    if (mode === "future") expect(packet.validUntil).toBe("2026-10-06T12:00:00.100Z");
    await f.guard();
    f.final();
    f.source.assertFinalized();
  },
);
it.each([
  "digest",
  "selectedDigest",
  "wrongAuthor",
  "contentBinding",
  "tenantContent",
  "accessor",
  "extra",
  "oversize",
])("rejects whole persisted material on %s corruption", async (mode) => {
  const f = fixture(),
    r = head(f.initial),
    getter = vi.fn(() => true);
  if (mode === "digest") r.release_receipt_digest = hash("wrong");
  if (mode === "selectedDigest") r.selected_receipt_digest = hash("wrong");
  if (mode === "wrongAuthor") Object.assign(r, head(f.initial, publication(f.initial, id(70))));
  if (mode === "contentBinding")
    Object.assign(r, head(f.initial, publication(f.initial, id(8), hash("different content"))));
  if (mode === "tenantContent") f.state.corruptTemplate = true;
  if (mode === "accessor")
    Object.defineProperty(r, "release_active", { enumerable: true, get: getter });
  if (mode === "extra") Object.assign(r, { allow: true });
  if (mode === "oversize") r.release_receipt_text = "x".repeat(65537);
  f.state.rows = [r];
  await expect(
    f.source.current({ templateVersionReference: f.initial.revision.templateVersionReference }),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  await expect(f.guard()).rejects.toThrow();
  expect(f.final).toThrow();
});
it.each([
  "familyFence",
  "lateArchive",
  "lateAbsentAppearance",
  "permission",
  "actor",
  "brand",
  "lifecycle",
  "query",
  "clock",
])("refuses %s drift until actual COMMIT", async (mode) => {
  const f = fixture();
  if (mode === "lateAbsentAppearance") f.state.rows = [];
  if (mode === "familyFence")
    f.state.onFence = () => {
      f.state.rows = [];
    };
  if (mode === "familyFence") {
    await expect(
      f.source.current({ templateVersionReference: f.initial.revision.templateVersionReference }),
    ).rejects.toThrow();
    return;
  }
  await f.source.current({ templateVersionReference: f.initial.revision.templateVersionReference });
  if (mode === "lateArchive") f.state.rows = [{ ...head(f.initial), release_active: false }];
  if (mode === "lateAbsentAppearance") f.state.rows = [head(f.initial)];
  if (mode === "permission") f.state.allowed = false;
  if (mode === "actor") f.state.actor = id(90);
  if (mode === "brand") f.state.brand = id(91);
  if (mode === "lifecycle") f.state.lifecycle = "Active";
  if (mode === "query") f.tx.query = async () => ({ rows: [] });
  if (mode === "clock") f.state.time = until;
  await expect(f.guard()).rejects.toThrow();
  expect(f.final).toThrow();
});
it("returns bounded actual candidates with scanned-family cursor and Tenant-first table fence", async () => {
  const f = fixture(),
    second = material(100);
  f.state.templates.set(String(second.revision.templateVersionReference), second);
  f.state.rows.push(head(second));
  const packet = await f.source.list({ afterTemplateReference: null, limit: 1 });
  expect(packet.items.map((i) => i.template.templateReference)).toEqual([
    f.initial.revision.templateReference,
  ]);
  expect(packet.hasMore).toBe(true);
  expect(packet.nextAfterTemplateReference).toBe(f.initial.revision.templateReference);
  const calls = f.query.mock.calls;
  const finalList = calls.findIndex(
    ([sql, values]) => sql.includes("brand_template_publication_list") && values[4] === true,
  );
  expect(
    calls
      .slice(finalList + 1)
      .some(([sql]) => sql.includes("platform_brand_template_reference_read")),
  ).toBe(false);
  expect(calls.some(([sql]) => sql.includes("brand_template_publication_hold"))).toBe(false);
  await f.guard();
  f.final();
  f.source.assertFinalized();
});
it.each(["changedPage", "lateAppearance", "sparse", "tooMany", "unordered"])(
  "refuses %s Published list without partial page",
  async (mode) => {
    const f = fixture();
    if (mode === "changedPage")
      f.state.onListFence = () => {
        f.state.rows = [];
      };
    if (mode === "lateAppearance") {
      f.state.rows = [];
      expect((await f.source.list({ afterTemplateReference: null, limit: 1 })).items).toEqual([]);
      f.state.rows = [head(f.initial)];
      await expect(f.guard()).rejects.toThrow();
      return;
    }
    if (mode === "sparse") f.state.rows = new Array(1);
    if (mode === "tooMany") f.state.rows = Array.from({ length: 22 }, () => head(f.initial));
    if (mode === "unordered") f.state.rows = [head(f.initial), head(f.initial)];
    await expect(f.source.list({ afterTemplateReference: null, limit: 20 })).rejects.toThrow();
    await expect(f.guard()).rejects.toThrow();
  },
);
it("pins the shortest authority/business deadline through the final sync seal", async () => {
  const f = fixture(material(10, { effectiveUntil: "2026-10-06T12:00:00.150Z" }));
  let calls = 0;
  f.state.onHold = async () => {
    if (++calls === 2) f.state.deadline = "2026-10-06T12:00:00.100Z";
  };
  expect(
    (
      await f.source.current({
        templateVersionReference: f.initial.revision.templateVersionReference,
      })
    ).validUntil,
  ).toBe("2026-10-06T12:00:00.100Z");
  await f.guard();
  f.state.deadline = until;
  f.state.time = "2026-10-06T12:00:00.100Z";
  expect(f.final).toThrow();
});
it("registers before malformed input, rejects reentry and poisons early finalize", async () => {
  const invalid = fixture();
  await expect(
    invalid.source.current({ templateVersionReference: id(11), allow: true }),
  ).rejects.toThrow();
  expect(invalid.register).toHaveBeenCalledTimes(1);
  await expect(invalid.guard()).rejects.toThrow();
  const reentry = fixture();
  reentry.state.onHold = async () => {
    await reentry.source.current({ templateVersionReference: id(11) }).catch(() => undefined);
  };
  await expect(reentry.source.current({ templateVersionReference: id(11) })).rejects.toThrow();
  await expect(reentry.guard()).rejects.toThrow();
  const early = fixture();
  expect(() => early.source.assertFinalized()).toThrow();
  await expect(early.source.current({ templateVersionReference: id(11) })).rejects.toThrow();
});
it("rejects duplicate mode changes, foreign scopes and non-READ-COMMITTED transactions", async () => {
  const f = fixture();
  await f.source.list({ afterTemplateReference: null, limit: 1 });
  await expect(f.source.current({ templateVersionReference: id(11) })).rejects.toThrow();
  await expect(f.guard()).rejects.toThrow();
  expect(() =>
    createPostgresPlatformTemplateBrandReferenceSource({
      ...f.options,
      scope: { ...f.options.scope, tenantReference: id(90) },
    }),
  ).toThrow();
  expect(() =>
    createPostgresPlatformTemplateBrandReferenceSource({
      ...f.options,
      originalValidUntil: "2026-10-06T12:00:05.001Z",
    }),
  ).toThrow();
  const isolation = fixture();
  isolation.state.isolation = "serializable";
  await expect(isolation.source.list({ afterTemplateReference: null, limit: 1 })).rejects.toThrow();
});
