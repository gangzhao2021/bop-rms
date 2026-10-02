import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  assessCatalogProductUniqueScope,
  planCatalogProductPublication,
  parseProductPublicationCommand,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  type ProductPublicationScope,
} from "../index.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T10:00:00.000Z",
  later = "2026-09-30T10:00:20.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const scope = (level = "Brand", reference: string | null = null): ProductPublicationScope => ({
  level: level as ProductPublicationScope["level"],
  reference,
  channelCodes: [],
  orderTypeCodes: [],
});
const period = (from = at, until: string | null = null) => ({
  timeZone: "UTC",
  effectiveFrom: { instant: from, localDateTime: from.slice(0, 23), utcOffsetMinutes: 0 },
  effectiveUntil:
    until === null
      ? null
      : { instant: until, localDateTime: until.slice(0, 23), utcOffsetMinutes: 0 },
});
function fixture(
  scopes = [scope("Store", id(20))],
  oldScopes = [scope()],
  oldPeriod = period(),
  scheduled = false,
) {
  const digest = hash("synthetic content"),
    base = {
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(40),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: digest,
      configurationDigest: digest,
      scopeSet: oldScopes,
      effectivePeriod: oldPeriod,
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_SCOPE",
    };
  const facts = {
    now: at,
    productAggregateVersion: 1,
    contentDigest: digest,
    configurationDigest: digest,
    scopeDigest: hash(oldScopes),
    periodDigest: hash(oldPeriod),
    validation: {
      evidenceReference: id(30),
      productAggregateVersion: 1,
      contentDigest: digest,
      configurationDigest: digest,
      scopeDigest: hash(oldScopes),
      periodDigest: hash(oldPeriod),
      policyReference: id(31),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: later,
    },
    approval: null,
    reviewReference: id(44),
    replacement: null,
  };
  let p = planCatalogProductPublication(base, null, facts);
  p = planCatalogProductPublication(
    { ...base, action: "SubmitReview", operationReference: id(41), expectedPublicationVersion: 1 },
    p,
    facts,
  );
  p = planCatalogProductPublication(
    {
      ...base,
      action: scheduled ? "SchedulePublish" : "Publish",
      scheduleReference: scheduled ? id(66) : null,
      operationReference: id(42),
      expectedPublicationVersion: 2,
      successorDraftVersionReference: scheduled ? null : id(7),
    },
    p,
    facts,
  );
  const command = {
    ...base,
    versionReference: id(7),
    expectedProductAggregateVersion: 2,
    scopeSet: scopes,
    operationReference: id(43),
  };
  const historyContent = {
    profile: "CatalogProductPublicationSourceV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    aggregateVersion: 2,
    observedAt: at,
    coverage: "Complete",
    eligibility: "NotEvaluated",
    history: [
      { action: scheduled ? "SchedulePublish" : "Publish", publication: p, configuration: {} },
    ],
    latest: [p],
  };
  const history = { ...historyContent, digest: hash(historyContent) };
  const stores = {
    profile: "TenantStoreReferenceV1",
    brandReference: id(2),
    brandLifecycle: "Active",
    brandVersion: "1",
    generation: "2",
    referenceCount: "2",
    originalIntentDigest: hash(parseProductPublicationCommand(command)),
    observedAt: at,
    references: [20, 21].map((n) => ({
      storeReference: id(n),
      lifecycle: "Active",
      version: "1",
      createdAt: at,
      updatedAt: at,
    })),
  };
  const policy = {
    content: {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(90),
      policyReference: id(31),
      policyVersion: 1,
      scopeOrder: productPublicationScopeLevels,
      approvalPolicy: "NotRequired",
      warningOverrideAllowed: false,
      requiredLocales: [],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: later,
    },
    currentPublicationReference: id(91),
    observedAt: at,
    validUntil: later,
  };
  return { command, history, stores, policy };
}
const run = (f: ReturnType<typeof fixture>, now = at) =>
  assessCatalogProductUniqueScope(f.command, f.history, f.stores, f.policy, now);
it("retains different precedence without claiming full validation or whole-version supersession", () => {
  const result = run(fixture());
  expect(result.check).toEqual({ code: "UniqueScope", outcome: "Pass" });
  expect(result.validUntil).toBe("2026-09-30T10:00:05.000Z");
  expect(result).toMatchObject({
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
    sourceAuthority: "NotEvaluated",
    supportedTopology: "RegisteredBrandStoreOnly",
  });
});
it("does not pick newest for equal-rank overlap", () => {
  const r = run(fixture([scope()], [scope()]));
  expect(r.check.outcome).toBe("HardError");
  expect(r.findings[0]?.reason).toBe("EQUAL_RANK_REQUIRES_DISPOSITION");
});
it("allows registered disjoint Stores", () =>
  expect(run(fixture([scope("Store", id(21))], [scope("Store", id(20))])).check.outcome).toBe(
    "Pass",
  ));
it.each(["Region", "StoreGroup"])("refuses unsupported current %s topology", (level) =>
  expect(run(fixture([scope(level, id(99))])).findings[0]?.reason).toBe(
    "CURRENT_TOPOLOGY_REQUIRED",
  ),
);
it("never treats an unknown Store as registered", () =>
  expect(run(fixture([scope("Store", id(99))])).findings[0]?.reason).toBe(
    "STORE_NOT_CURRENT_ACTIVE",
  ));
it("refuses archived registration without equating Active to module qualification", () => {
  const f = fixture();
  const store = f.stores.references[0];
  if (store) store.lifecycle = "Archived";
  expect(run(f).check.outcome).toBe("HardError");
});
it("does not infer registration from known empty coverage", () => {
  const f = fixture();
  f.stores.references = [];
  f.stores.referenceCount = "0";
  expect(run(f).findings.some((x) => x.reason === "NO_REGISTERED_STORES")).toBe(true);
});
it("preserves half-open adjacent effective periods", () => {
  const boundary = "2026-09-30T10:00:02.000Z",
    f = fixture([scope()], [scope()], period(at, boundary));
  f.command.effectivePeriod = period(boundary);
  f.stores.originalIntentDigest = hash(f.command);
  expect(run(f).check.outcome).toBe("Pass");
});
it.each([
  "tenant",
  "brand",
  "product",
  "root",
  "digest",
  "head",
  "intent",
  "observation",
  "policy",
  "lease",
  "future",
])("rejects mismatched held-source %s", (kind) => {
  const f = fixture();
  if (kind === "tenant") f.command.tenantReference = id(99);
  if (kind === "brand") f.command.brandReference = id(99);
  if (kind === "product") f.command.productReference = id(99);
  if (kind === "root") f.command.expectedProductAggregateVersion = 3;
  if (kind === "digest") f.history.digest = hash("wrong");
  if (kind === "head") f.command.expectedPublicationVersion = 1;
  if (kind === "intent") f.stores.originalIntentDigest = hash("wrong");
  if (kind === "observation") f.stores.observedAt = later;
  if (kind === "policy") f.policy.content.brandReference = id(99);
  if (kind === "lease") f.policy.validUntil = at;
  if (kind === "future") f.command.occurredAt = later;
  expect(() => run(f)).toThrow();
});
it("expires at the five-second source boundary", () =>
  expect(() => run(fixture(), "2026-09-30T10:00:05.000Z")).toThrow());
it("never invokes source accessors", () => {
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f.history, "latest", { get: getter });
  expect(() => run(f)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("reserves a future scheduled interval rather than ignoring unpublished activation", () => {
  const f = fixture([scope()], [scope()], period("2026-09-30T10:00:10.000Z"), true);
  expect(run(f).check.outcome).toBe("HardError");
  expect(run(f).findings.some((x) => x.reason === "EQUAL_RANK_REQUIRES_DISPOSITION")).toBe(true);
});
it.each(["channelCodes", "orderTypeCodes"] as const)("allows disjoint %s", (dimension) => {
  const incoming = { ...scope(), [dimension]: [dimension === "channelCodes" ? "WEB" : "PICKUP"] },
    previous = { ...scope(), [dimension]: [dimension === "channelCodes" ? "POS" : "DELIVERY"] };
  expect(run(fixture([incoming], [previous])).check.outcome).toBe("Pass");
});
it("does not hide a Brand overlap behind another Store selector in the same union", () => {
  expect(run(fixture([scope("Store", id(20)), scope()], [scope()])).check.outcome).toBe(
    "HardError",
  );
});

it("never tolerates a command two milliseconds later than its owning SQL observation", () => {
  const f = fixture();
  f.command.occurredAt = "2026-09-30T10:00:00.002Z";
  f.stores.originalIntentDigest = hash(parseProductPublicationCommand(f.command));
  expect(() => run(f)).toThrow();
});
