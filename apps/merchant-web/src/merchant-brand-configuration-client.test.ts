// Controlled frontend wire evidence; these fixtures do not qualify real materials.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantBrandConfigurationClient,
  parseBrandTemplateCandidates,
  parseBrandConfigurationCommand,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  validateBrandConfigurationRevision,
  validateBrandConfigurationReceipt,
} from "./merchant-brand-configuration-client.js";
import { publicationValueDigest as hash } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
const scope = { tenantReference: id(1), brandReference: id(1), actorReference: id(2) };
const csrf = "a".repeat(43);
const editable = {
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  mediaThemeReference: null,
  catalogSourceReference: id(3),
  platformTemplateReference: id(4),
  overrideAllowedFieldCodes: ["CONTACT"],
  hardRequirementFieldCodes: ["CURRENCY"],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "AUTHOR_EDIT",
};
const command = () => ({
  profile: "TenantBrandConfigurationCommandV1",
  ...scope,
  command: "SaveConfigurationDraft",
  operationReference: id(5),
  expectedBrandVersion: 1,
  expectedHead: null,
  purposeCode: "BRAND_CONFIGURATION",
  configuration: editable,
  reviewValidUntil: null,
});
const current = (revision: unknown = null, recordedReview: unknown = null) => ({
  profile: "TenantBrandConfigurationCurrentV1",
  ...scope,
  current: revision,
  recordedReview,
  observedAt: at,
  validUntil: until,
  currentPublication: "NotEvaluated",
});
const history = (entries: unknown[] = []) => ({
  profile: "TenantBrandConfigurationHistoryV1",
  ...scope,
  beforeRevision: null,
  entries,
  nextBeforeRevision: null,
  observedAt: at,
  validUntil: until,
  currentPublication: "NotEvaluated",
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function revision(submitted = false) {
  const configuration = {
    ...editable,
    configurationVersionReference: id(6),
    brandReference: id(1),
    configurationVersion: 1,
    lifecycle: submitted ? "PendingApproval" : "Draft",
    supersedesVersionReference: null,
    authoredByReference: id(2),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const {
    lifecycle,
    approvedByReference,
    approvalEvidenceReference,
    publicationReference,
    updatedAt,
    ...semantic
  } = configuration;
  void lifecycle;
  void approvedByReference;
  void approvalEvidenceReference;
  void publicationReference;
  void updatedAt;
  const contentDigest = await hash({
    profile: "TenantBrandConfigurationContentV1",
    ...semantic,
    supportedLocales: [...editable.supportedLocales].sort(),
    overrideAllowedFieldCodes: [...editable.overrideAllowedFieldCodes].sort(),
    hardRequirementFieldCodes: [...editable.hardRequirementFieldCodes].sort(),
  });
  const r = {
    profile: "TenantBrandConfigurationRevisionV1",
    ...scope,
    revision: submitted ? 2 : 1,
    brandVersion: 1,
    command: submitted ? "SubmitConfiguration" : "SaveConfigurationDraft",
    operationReference: id(5),
    configuration,
    submittedByReference: submitted ? id(2) : null,
    publishing: submitted
      ? {
          familyReference: id(1),
          lifecycleReference: id(7),
          lifecycleVersion: 2,
          mutationOperationReference: id(8),
          validationEvidenceReference: id(9),
          approvalEvidenceReference: null,
          publicationReference: null,
        }
      : null,
    contentDigest,
    auditReference: id(10),
    createdAt: at,
    recordedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  return { ...r, sourceDigest: await hash(r) };
}
it("sends only closed Brand transport fields with CSRF, cookies and no-store", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(current()));
  const client = createMerchantBrandConfigurationClient(fetcher);
  await client.current(scope, { csrf });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/organization/brands/configuration/current");
  const options = fetcher.mock.calls[0]?.[1];
  expect(JSON.parse(String(options?.body))).toEqual({ brandReference: id(1) });
  expect(options).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "X-BOP-CSRF": csrf },
  });
});
it("hashes actual owning intent, keeps scalar original, and maps resolve command body", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(null, 409));
  const client = createMerchantBrandConfigurationClient(fetcher);
  const prepared = await client.prepare(command());
  expect(prepared.original.intentDigest).toBe(await hash(prepared.command));
  expect(prepared.original).not.toHaveProperty("configuration");
  expect(prepared.original).not.toHaveProperty("reviewValidUntil");
  await expect(client.resolve(prepared.original, { csrf })).rejects.toMatchObject({
    code: "Conflict",
  });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    brandReference: id(1),
    command: {
      command: "SaveConfigurationDraft",
      operationReference: id(5),
      expectedBrandVersion: 1,
      expectedHead: null,
      intentDigest: prepared.original.intentDigest,
    },
  });
});
it("validates both owning hashes and allows a reader different from the immutable author", async () => {
  const r = await revision();
  await expect(validateBrandConfigurationRevision(r)).resolves.toMatchObject({ revision: 1 });
  const reader = { ...scope, actorReference: id(11) };
  await expect(
    parseBrandConfigurationCurrent({ ...current(r), ...reader }, reader),
  ).resolves.toMatchObject({ actorReference: id(11) });
  await expect(
    parseBrandConfigurationHistory({ ...history([r]), ...reader }, reader, null),
  ).resolves.toMatchObject({ entries: [{ actorReference: id(2) }] });
  await expect(
    validateBrandConfigurationRevision({
      ...r,
      configuration: { ...r.configuration, reasonCode: "TAMPER" },
    }),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("requires original recorded review pins while displaying an expired business deadline", async () => {
  const r = await revision(true),
    packet = {
      profile: "MerchantBrandConfigurationRecordedReviewV1",
      configurationVersionReference: id(6),
      configurationSourceDigest: r.sourceDigest,
      lifecycleReference: id(7),
      lifecycleVersion: 2,
      recordedState: "PendingApproval",
      validationEvidenceReference: id(9),
      submittedByReference: id(2),
      submittedAt: at,
      reviewValidUntil: "2026-10-06T10:00:01.000Z",
    };
  await expect(parseBrandConfigurationCurrent(current(r), scope)).rejects.toMatchObject({
    code: "Invalid",
  });
  const later = {
    ...current(r, packet),
    observedAt: "2026-10-06T10:00:02.000Z",
    validUntil: "2026-10-06T10:00:07.000Z",
  };
  await expect(parseBrandConfigurationCurrent(later, scope)).resolves.toMatchObject({
    recordedReview: { reviewValidUntil: packet.reviewValidUntil },
    validUntil: later.validUntil,
  });
  await expect(
    parseBrandConfigurationCurrent(
      current(r, { ...packet, configurationSourceDigest: "sha256:" + "a".repeat(64) }),
      scope,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("refuses browser authority fields, accessors and missing explicit submit deadline", () => {
  expect(() => parseBrandConfigurationCommand({ ...command(), qualification: true })).toThrow();
  const getter = vi.fn(() => editable);
  expect(() =>
    parseBrandConfigurationCommand({
      ...command(),
      get configuration() {
        return getter();
      },
    }),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    parseBrandConfigurationCommand({
      ...command(),
      command: "SubmitConfiguration",
      expectedHead: {
        revision: 1,
        configurationVersionReference: id(6),
        sourceDigest: "sha256:" + "a".repeat(64),
      },
      configuration: null,
    }),
  ).toThrow();
});
it("validates exact committed owner receipt rather than trusting a success status", async () => {
  const client = createMerchantBrandConfigurationClient();
  const prepared = await client.prepare(command()),
    r = await revision();
  const { profile, ...pins } = prepared.original;
  void profile;
  const receipt = {
    profile: "TenantBrandConfigurationOperationV1",
    ...pins,
    originalCommand: prepared.command,
    outcome: "Committed",
    snapshot: r,
    auditReference: id(10),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  await expect(
    validateBrandConfigurationReceipt(receipt, prepared.original),
  ).resolves.toMatchObject({ outcome: "Committed" });
  await expect(
    validateBrandConfigurationReceipt(
      { ...receipt, snapshot: { ...r, sourceDigest: "sha256:" + "b".repeat(64) } },
      prepared.original,
    ),
  ).rejects.toThrow();
});
it("maps a real refusal separately from an unknown write and rejects stale reads", async () => {
  const denied = createMerchantBrandConfigurationClient(async () => response(null, 403));
  await expect(denied.current(scope, { csrf })).rejects.toMatchObject({ code: "Denied" });
  const lost = createMerchantBrandConfigurationClient(async () => {
    throw new Error("lost response");
  });
  const prepared = await lost.prepare(command());
  await expect(lost.execute(prepared, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  const stale = createMerchantBrandConfigurationClient(async () => response(current()));
  await expect(stale.current(scope, { csrf })).rejects.toMatchObject({ code: "Stale" });
});
it("rejects an older generation after another scope request and never sends an already aborted read", async () => {
  let release: (value: Response) => void = () => undefined;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementationOnce(async () => response(current()));
  const client = createMerchantBrandConfigurationClient(fetcher),
    old = client.current(scope, { csrf });
  const rejection = expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
  await client.current(scope, { csrf });
  release(response(current()));
  await rejection;
  const controller = new AbortController();
  controller.abort();
  await expect(client.current(scope, { csrf, signal: controller.signal })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

const templateCandidate = () => ({
  templateReference: id(20),
  templateVersionReference: id(21),
  revision: 1,
  contentDigest: "sha256:" + "a".repeat(64),
  code: "STANDARD",
  name: "Standard brand",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  overrideAllowedFieldCodes: ["CONTACT"],
  hardRequirementFieldCodes: ["CURRENCY"],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "TEMPLATE_AUTHORING",
});
const candidatePage = () => ({
  profile: "MerchantBrandTemplateCandidatesV1",
  ...scope,
  afterTemplateReference: null,
  items: [templateCandidate()],
  hasMore: false,
  nextAfterTemplateReference: null,
  observedAt: at,
  validUntil: until,
});
it("reads only closed published-template candidates through the authenticated same-origin bounded query", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(candidatePage())),
    client = createMerchantBrandConfigurationClient(fetcher),
    page = await client.templates(scope, null, { csrf });
  expect(page.items[0]?.name).toBe("Standard brand");
  expect(Object.isFrozen(page.items[0])).toBe(true);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/organization/brands/configuration/templates",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: expect.objectContaining({ "X-BOP-CSRF": csrf }),
      body: JSON.stringify({ afterTemplateReference: null, brandReference: scope.brandReference }),
    }),
  );
});
it.each(["actor", "cursor", "extra", "lease", "duplicate", "overlap", "future"])(
  "rejects incompatible candidate %s before selection",
  (field) => {
    const base = candidatePage(),
      raw =
        field === "actor"
          ? { ...base, actorReference: id(99) }
          : field === "cursor"
            ? { ...base, afterTemplateReference: id(20) }
            : field === "extra"
              ? { ...base, publication: "Published" }
              : field === "lease"
                ? { ...base, validUntil: "2026-10-06T10:00:06.000Z" }
                : field === "duplicate"
                  ? { ...base, items: [templateCandidate(), templateCandidate()] }
                  : field === "overlap"
                    ? {
                        ...base,
                        items: [{ ...templateCandidate(), hardRequirementFieldCodes: ["CONTACT"] }],
                      }
                    : { ...base, items: [{ ...templateCandidate(), effectiveFrom: until }] };
    expect(() => parseBrandTemplateCandidates(raw, scope, null)).toThrow();
  },
);
it("rejects candidate expiry and scope drift after an asynchronous response", async () => {
  const stale = createMerchantBrandConfigurationClient(async () => response(candidatePage()));
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(stale.templates(scope, null, { csrf })).rejects.toMatchObject({ code: "Stale" });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const mutable = { ...scope },
    client = createMerchantBrandConfigurationClient(async () => {
      mutable.actorReference = id(88);
      return response(candidatePage());
    });
  await expect(client.templates(mutable, null, { csrf })).rejects.toMatchObject({
    code: "ScopeChanged",
  });
});

it("accepts an empty scanned page while requiring its real cursor to advance", () => {
  const page = { ...candidatePage(), items: [], hasMore: true, nextAfterTemplateReference: id(22) };
  expect(parseBrandTemplateCandidates(page, scope, null).items).toEqual([]);
  const second = { ...page, afterTemplateReference: id(22), nextAfterTemplateReference: id(23) };
  expect(parseBrandTemplateCandidates(second, scope, id(22)).nextAfterTemplateReference).toBe(
    id(23),
  );
  expect(() =>
    parseBrandTemplateCandidates({ ...second, nextAfterTemplateReference: id(22) }, scope, id(22)),
  ).toThrow();
  expect(() =>
    parseBrandTemplateCandidates({ ...second, afterTemplateReference: id(21) }, scope, id(22)),
  ).toThrow();
});

it("keeps candidate observation wholly inside each finite template business window", () => {
  const base = candidatePage();
  expect(() =>
    parseBrandTemplateCandidates(
      { ...base, items: [{ ...templateCandidate(), effectiveUntil: "2026-10-06T10:00:01.000Z" }] },
      scope,
      null,
    ),
  ).toThrow();
  expect(
    parseBrandTemplateCandidates(
      { ...base, items: [{ ...templateCandidate(), effectiveUntil: until }] },
      scope,
      null,
    ).validUntil,
  ).toBe(until);
});
