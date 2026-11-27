import { parsePublishingReference, parsePublishingVersion } from "@bop/publishing";
import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { applyCatalogProductUniqueScopeValidation } from "../application/product-unique-scope-validation.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationValidation,
} from "../contracts/product-publication.js";
import { parseCatalogInstant } from "../index.js";
import { productPublicationCheckCodes } from "../domain/product-publication.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T11:00:00.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const command = parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: "sha256:" + "a".repeat(64),
    configurationDigest: "sha256:" + "b".repeat(64),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
  });
  const validation = parseProductPublicationValidation({
    evidenceReference: id(7),
    productAggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeDigest: hash(command.scopeSet),
    periodDigest: hash(command.effectivePeriod),
    policyReference: id(8),
    policyVersion: 1,
    approvalPolicy: "Required",
    checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
    warningAcknowledgement: null,
    checkedAt: at,
    validUntil: "2026-10-02T11:00:30.000Z",
  });
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    versionReference: id(6),
    aggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    originalIntentDigest: hash(command),
    policyReference: parsePublishingReference(id(8)),
    policyVersion: parsePublishingVersion(1),
    observedAt: parseCatalogInstant(at),
    validUntil: parseCatalogInstant("2026-10-02T11:00:05.000Z"),
    check: { code: "UniqueScope" as const, outcome: "HardError" as const },
  };
  return {
    command,
    validation,
    scope,
    apply: (s = scope, v = validation, now = at) =>
      applyCatalogProductUniqueScopeValidation(command, v, s, now),
  };
}
it("replaces the wire placeholder with the actual check and owning summary, preserving other ten checks/evidence", () => {
  const f = fixture(),
    result = f.apply();
  expect(result.checks.find((x) => x.code === "UniqueScope")?.outcome).toBe("HardError");
  expect(result.checks.find((x) => x.code === "HardErrorsCleared")?.outcome).toBe("HardError");
  expect(result.validUntil).toBe(f.scope.validUntil);
  for (const check of f.validation.checks.filter(
    (x) => !["UniqueScope", "HardErrorsCleared"].includes(x.code),
  ))
    expect(result.checks).toContainEqual(check);
  expect(result.evidenceReference).toBe(f.validation.evidenceReference);
  expect(result.warningAcknowledgement).toBeNull();
  expect(f.validation.checks.every((x) => x.outcome === "Pass")).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
});
it("does not clear another current hard error when actual scope passes", () => {
  const f = fixture(),
    v = parseProductPublicationValidation({
      ...f.validation,
      checks: f.validation.checks.map((x) => ({
        ...x,
        outcome: x.code === "MediaReady" || x.code === "HardErrorsCleared" ? "HardError" : "Pass",
      })),
    });
  const result = applyCatalogProductUniqueScopeValidation(
    f.command,
    v,
    { ...f.scope, check: { code: "UniqueScope", outcome: "Pass" } },
    at,
  );
  expect(result.checks.find((x) => x.code === "HardErrorsCleared")?.outcome).toBe("HardError");
});
it.each([
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "contentDigest",
  "configurationDigest",
  "originalIntentDigest",
  "policyReference",
] as const)("refuses foreign held %s", (key) => {
  const f = fixture();
  expect(() => f.apply({ ...f.scope, [key]: id(99) })).toThrow();
});
it.each(["aggregateVersion", "policyVersion"] as const)("refuses changed %s", (key) => {
  const f = fixture();
  expect(() => f.apply({ ...f.scope, [key]: 2 } as never)).toThrow();
});
it.each(["2026-10-02T10:59:59.999Z", "2026-10-02T11:00:05.000Z"])(
  "refuses future/exclusive expired observation %s",
  (now) => {
    expect(() => fixture().apply(undefined, undefined, now)).toThrow();
  },
);
it("refuses supplied conflicting scope and incomplete full remaining validation", () => {
  const f = fixture();
  expect(() =>
    f.apply(
      f.scope,
      parseProductPublicationValidation({
        ...f.validation,
        checks: f.validation.checks.map((x) => ({
          ...x,
          outcome:
            x.code === "UniqueScope" || x.code === "HardErrorsCleared" ? "HardError" : "Pass",
        })),
      }),
    ),
  ).toThrow();
  expect(() =>
    applyCatalogProductUniqueScopeValidation(
      f.command,
      { ...f.validation, checks: [] },
      f.scope,
      at,
    ),
  ).toThrow();
});
it("refuses accessor/extra binding and System/non Validate without invoking accessors", () => {
  const f = fixture(),
    get = vi.fn();
  expect(() =>
    f.apply(Object.defineProperty({ ...f.scope }, "check", { get, enumerable: true })),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(() => f.apply({ ...f.scope, extra: true } as never)).toThrow();
  expect(() =>
    applyCatalogProductUniqueScopeValidation(
      { ...f.command, action: "SubmitReview" },
      f.validation,
      f.scope,
      at,
    ),
  ).toThrow();
});
