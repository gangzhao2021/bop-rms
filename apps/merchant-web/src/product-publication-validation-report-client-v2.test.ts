import { expect, it, vi } from "vitest";
import {
  assertProductPublicationValidationReportSelection,
  createProductPublicationValidationReportClientV2,
  parseProductPublicationValidationReportViewV2,
} from "./product-publication-validation-report-client-v2.js";
import { parseProductPublicationManagementViewV2 } from "./product-publication-management-client-v2.js";
import { canonicalPublicationValue } from "./product-publication-command-client-v2.js";
import {
  at,
  csrf,
  digest,
  hash,
  id,
  oldPublication,
  request as managementRequest,
  response,
  scope,
  seal,
  validatedManagement,
  validationReportView,
} from "./product-publication-v2-test-fixtures.js";
const now = () => Date.parse(at);
const request = {
  ...scope,
  versionReference: id(6),
  expectedAggregateVersion: 7,
  expectedPublicationVersion: 0,
};
function publication() {
  const p = validatedManagement().versions[0];
  if (!p) throw new Error("Missing synthetic publication");
  return p;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing synthetic object");
  return value as Record<string, unknown>;
}
function reseal(raw: ReturnType<typeof validationReportView>) {
  if (raw.report) {
    const r = raw.report,
      v = object(r.validation),
      d = object(r.details);
    if (d.coverage === "Complete") {
      const findings = d.findings as Record<string, unknown>[],
        sources = d.sources as Record<string, unknown>[];
      d.findings = findings.sort((a, b) =>
        canonicalPublicationValue(a).localeCompare(canonicalPublicationValue(b), "en"),
      );
      for (const f of findings)
        (f.references as Record<string, unknown>[]).sort((a, b) =>
          canonicalPublicationValue(a).localeCompare(canonicalPublicationValue(b), "en"),
        );
      r.warningBindingDigest = digest({
        binding: r.binding,
        warningCodes: (v.checks as { code: string; outcome: string }[])
          .filter((c) => c.outcome === "Warning")
          .map((c) => c.code),
        findings: d.findings,
        references: sources
          .map((s) => ({
            sourceCode: s.sourceCode,
            relevantReferenceDigest: s.relevantReferenceDigest,
          }))
          .sort((a, b) => String(a.sourceCode).localeCompare(String(b.sourceCode), "en")),
      });
    }
    raw.report = seal(r);
  }
  return seal(raw);
}
const capability = (observedAt = at) => ({
  brandReference: id(2),
  storeReference: id(3),
  capabilityKey: "catalog.cat_product_edit",
  controlKey: "catalog.product.edit",
  backendExecution: "Allow",
  frontendVisibility: "Show",
  reason: "Enabled",
  source: "StoreOverride",
  controlReference: id(80),
  controlVersion: 1,
  observedAt,
});
it("distinguishes an actual unvalidated Draft from legacy absent reports", async () => {
  const draft = await parseProductPublicationValidationReportViewV2(
    validationReportView(),
    request,
    now,
  );
  expect(draft).toMatchObject({
    status: "NotValidated",
    applicability: "NotValidated",
    report: null,
    publicationVersion: 0,
  });
  const raw = validationReportView(oldPublication());
  const legacy = await parseProductPublicationValidationReportViewV2(
    raw,
    { ...request, versionReference: id(5), expectedPublicationVersion: 1 },
    now,
  );
  expect(legacy).toMatchObject({
    status: "NotRecorded",
    applicability: "HistoricalVersion",
    report: null,
  });
  await expect(
    parseProductPublicationValidationReportViewV2(
      seal({ ...raw, status: "NotValidated" }),
      { ...request, versionReference: id(5), expectedPublicationVersion: 1 },
      now,
    ),
  ).rejects.toThrow();
});
it.each([false, true])(
  "reads original %s Complete report after its historical validation deadline without granting eligibility",
  async (complete) => {
    const observedAt = "2026-10-02T12:00:00.000Z",
      raw = validationReportView(publication(), { observedAt, complete }),
      view = await parseProductPublicationValidationReportViewV2(
        raw,
        { ...request, expectedPublicationVersion: 1 },
        () => Date.parse(observedAt),
      );
    expect(view.report).toEqual(raw.report);
    expect(view.report?.validation.validUntil).toBe("2026-10-01T12:00:05.000Z");
    expect(view.report?.validation.checks.find((c) => c.code === "ApprovalPolicy")?.outcome).toBe(
      "Pending",
    );
    expect(view.report?.details.coverage).toBe(complete ? "Complete" : "ChecksOnly");
    expect(view.eligibility).toBe("NotEvaluated");
    expect(Object.isFrozen(view.report?.validation.checks)).toBe(true);
  },
);
it("distinguishes changed saved Draft content from an unchanged recorded head", async () => {
  const raw = validationReportView(publication(), {
    draftContentDigest: digest("later saved content"),
    aggregateVersion: 9,
  });
  const view = await parseProductPublicationValidationReportViewV2(
    raw,
    { ...request, expectedAggregateVersion: 9, expectedPublicationVersion: 1 },
    now,
  );
  expect(view.applicability).toBe("ChangedDraftContent");
  expect(view.report?.binding.contentDigest).toBe(hash);
  await expect(
    parseProductPublicationValidationReportViewV2(
      seal({ ...raw, applicability: "CurrentDraftContent" }),
      { ...request, expectedAggregateVersion: 9, expectedPublicationVersion: 1 },
      now,
    ),
  ).rejects.toThrow();
});
it("detaches the full report before asynchronous hashing and never invokes accessors", async () => {
  const raw = validationReportView(publication(), { complete: true }),
    original = structuredClone(raw);
  const pending = parseProductPublicationValidationReportViewV2(
    raw,
    { ...request, expectedPublicationVersion: 1 },
    now,
  );
  object(raw.report).recordedAt = "2099-01-01T00:00:00.000Z";
  expect(await pending).toEqual(original);
  const getter = vi.fn(),
    malformed = Object.defineProperty(validationReportView(), "report", {
      enumerable: true,
      get: getter,
    });
  await expect(
    parseProductPublicationValidationReportViewV2(malformed, request, now),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  "scope",
  "root",
  "publicationVersion",
  "headOperation",
  "headDigest",
  "reportOwner",
  "reportRoot",
  "duplicateCheck",
  "pendingMedia",
  "hardErrors",
  "ackPending",
  "missingFinding",
  "sourceLease",
  "profile",
  "extra",
  "currentUnavailable",
])("refuses %s even after rebuilding envelope digests", async (mode) => {
  const raw = validationReportView(publication(), { complete: true }),
    r = object(raw.report),
    v = object(r.validation),
    b = object(r.binding),
    d = object(r.details),
    checks = v.checks as { code: string; outcome: string }[];
  if (mode === "scope") raw.storeReference = id(99);
  if (mode === "root") raw.aggregateVersion++;
  if (mode === "publicationVersion") raw.publicationVersion++;
  if (mode === "headOperation") raw.selectedPublicationOperationReference = id(99);
  if (mode === "headDigest") raw.selectedPublicationDigest = hash;
  if (mode === "reportOwner") b.productReference = id(99);
  if (mode === "reportRoot") r.resultAggregateVersion = 99;
  if (mode === "duplicateCheck") checks[1] = { code: "ApprovalPolicy", outcome: "Pending" };
  if (mode === "pendingMedia") {
    const c = checks.find((c) => c.code === "MediaReady");
    if (c) c.outcome = "Pending";
  }
  if (mode === "hardErrors") {
    const c = checks.find((c) => c.code === "MediaReady");
    if (c) c.outcome = "HardError";
  }
  if (mode === "ackPending")
    v.warningAcknowledgement = {
      actorReference: id(70),
      reasonCode: "SYNTHETIC",
      warningCodes: ["ApprovalPolicy"],
    };
  if (mode === "missingFinding") {
    const c = checks.find((c) => c.code === "ChangeImpact");
    if (c) c.outcome = "Warning";
  }
  if (mode === "sourceLease")
    object((d.sources as unknown[])[0]).validUntil = "2026-10-01T12:00:04.000Z";
  if (mode === "profile") raw.profile = "CatalogProductPublicationManagementV2";
  if (mode === "extra") Object.assign(raw, { currentEligibility: "Pass" });
  if (mode === "currentUnavailable") raw.currentDraft.contentStatus = "Unavailable";
  await expect(
    parseProductPublicationValidationReportViewV2(
      reseal(raw),
      { ...request, expectedPublicationVersion: 1 },
      now,
    ),
  ).rejects.toThrow();
});
it("binds every report field to the separately validated immutable selected head", async () => {
  const management = await parseProductPublicationManagementViewV2(
      validatedManagement(),
      managementRequest,
      now,
    ),
    p = management.versions[0];
  if (!p) throw new Error("Missing selected synthetic head");
  const raw = validationReportView(publication()),
    view = await parseProductPublicationValidationReportViewV2(
      raw,
      { ...request, expectedPublicationVersion: 1 },
      now,
    );
  await expect(assertProductPublicationValidationReportSelection(view, p)).resolves.toBeUndefined();
  for (const change of ["binding", "originalIntent", "decision"]) {
    const bad = structuredClone(raw),
      r = object(bad.report),
      v = object(r.validation);
    if (change === "binding") {
      object(r.binding).scopeDigest = hash;
      v.scopeDigest = hash;
    }
    if (change === "originalIntent") r.originalIntentDigest = digest("different original command");
    if (change === "decision") {
      const c = (v.checks as { code: string; outcome: string }[]).find(
        (c) => c.code === "ApprovalPolicy",
      );
      if (c) c.outcome = "Pass";
    }
    const parsed = await parseProductPublicationValidationReportViewV2(
      reseal(bad),
      { ...request, expectedPublicationVersion: 1 },
      now,
    );
    await expect(
      assertProductPublicationValidationReportSelection(parsed, p),
    ).rejects.toMatchObject({ code: "ScopeChanged" });
  }
});
it("accepts a large legitimate complete report and rejects the independent stored report byte limit", async () => {
  const make = (count: number) => {
    const p = { ...publication(), validationDecision: "WarningAcknowledgementRequired" },
      raw = validationReportView(p, { complete: true }),
      details = object(object(raw.report).details);
    details.findings = Array.from({ length: count }, (_, n) => ({
      checkCode: "ChangeImpact",
      ruleCode: "SYNTHETIC_RULE_" + "R".repeat(49),
      outcome: "Warning",
      subjectReference: id(1000 + n),
      reasonCode: "SYNTHETIC_REASON_" + "X".repeat(47),
      references: Array.from({ length: 4 }, (_, i) => ({
        sourceCode: "SYNTHETIC_VALIDATION",
        resourceReference: id(10000 + n * 4 + i),
        versionReference: id(20000 + n * 4 + i),
        referenceDigest: hash,
      })),
    }));
    return reseal(raw);
  };
  const accepted = make(600),
    rejected = make(1000);
  expect(new TextEncoder().encode(JSON.stringify(accepted)).length).toBeGreaterThan(600000);
  expect(new TextEncoder().encode(JSON.stringify(rejected)).length).toBeLessThan(2 * 1024 * 1024);
  expect(
    (
      await parseProductPublicationValidationReportViewV2(
        accepted,
        { ...request, expectedPublicationVersion: 1 },
        now,
      )
    ).report?.details.coverage,
  ).toBe("Complete");
  await expect(
    parseProductPublicationValidationReportViewV2(
      rejected,
      { ...request, expectedPublicationVersion: 1 },
      now,
    ),
  ).rejects.toThrow();
});
it("checks its own current capability before the exact four-field report POST and retains the earliest lease", async () => {
  let clock = now();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(capability()))
    .mockImplementationOnce(async () => {
      clock += 1000;
      return response(validationReportView(null, { observedAt: new Date(clock).toISOString() }));
    });
  const observed = await createProductPublicationValidationReportClientV2(
    fetcher,
    () => clock,
  ).load({ request, csrf }, new AbortController().signal);
  expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
    "/merchant/store-capability",
    "/merchant/catalog/products/publication/validation-report/v2",
  ]);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify({
      productReference: id(4),
      versionReference: id(6),
      expectedAggregateVersion: 7,
      expectedPublicationVersion: 0,
    }),
    headers: { "x-bop-csrf": csrf },
  });
  const header = new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("x-bop-catalog-scope");
  expect(header).not.toBeNull();
  expect(JSON.parse(atob(String(header).replace(/-/gu, "+").replace(/_/gu, "/")))).toEqual({
    brandReference: id(2),
    storeReference: id(3),
  });
  expect(observed.validUntil).toBe("2026-10-01T12:00:05.000Z");
  expect(observed.view.validUntil).toBe("2026-10-01T12:00:06.000Z");
});
it.each(["denied", "disabled", "scope"])(
  "never requests report bytes after %s capability",
  async (mode) => {
    const c = capability();
    if (mode === "disabled")
      Object.assign(c, {
        backendExecution: "Deny",
        frontendVisibility: "Hide",
        reason: "Disabled",
      });
    if (mode === "scope") c.storeReference = id(99);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(
          mode === "denied" ? { error: "request_denied" } : c,
          mode === "denied" ? 403 : 200,
        ),
      );
    await expect(
      createProductPublicationValidationReportClientV2(fetcher, now).load(
        { request, csrf },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each(["denied", "expired", "cached", "oversize", "invalid"])(
  "rejects %s report without altering any command journal",
  async (mode) => {
    let clock = now();
    const raw = validationReportView(),
      fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(capability()))
        .mockImplementationOnce(async () => {
          if (mode === "expired") clock += 5000;
          const r = response(
            mode === "denied"
              ? { error: "request_denied" }
              : mode === "invalid"
                ? { error: "product_publication_validation_report_invalid" }
                : raw,
            mode === "denied" ? 403 : mode === "invalid" ? 400 : 200,
          );
          if (mode === "cached") r.headers.set("cache-control", "private");
          if (mode === "oversize") r.headers.set("content-length", "2097153");
          return r;
        });
    await expect(
      createProductPublicationValidationReportClientV2(fetcher, () => clock).load(
        { request, csrf },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code:
        mode === "denied"
          ? "Denied"
          : mode === "expired"
            ? "Stale"
            : mode === "invalid"
              ? "Invalid"
              : "Unavailable",
    });
  },
);
it("cancels a late non-cooperative report transport on scope departure", async () => {
  const controller = new AbortController();
  let enter: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(capability()))
      .mockImplementationOnce(() => {
        enter?.();
        return new Promise<Response>(() => undefined);
      });
  const pending = createProductPublicationValidationReportClientV2(fetcher, now).load(
    { request, csrf },
    controller.signal,
  );
  await entered;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
