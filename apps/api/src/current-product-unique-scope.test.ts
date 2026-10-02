import { expect, it, vi } from "vitest";
import { CatalogError, parseCatalogReference } from "@rms/catalog";
import { createCurrentProductUniqueScopeSource } from "./current-product-unique-scope.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T10:00:00.000Z";
function input() {
  return {
    command: {
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(5),
      productReference: id(6),
      versionReference: id(7),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: "sha256:" + "a".repeat(64),
      configurationDigest: "sha256:" + "b".repeat(64),
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_SCOPE",
    },
    policyReference: id(8),
    policyVersion: 1,
  };
}
function fixture() {
  const validationAuthority = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => undefined),
    },
    historyAuthority = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => {
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
    },
    tenantAuthority = { withCurrentBrandReferenceRead: vi.fn(), isCurrent: vi.fn() },
    policySource = {
      context: {
        tenantReference: parseCatalogReference(id(1)),
        brandReference: parseCatalogReference(id(2)),
        actorReference: parseCatalogReference(id(3)),
        actorKind: "User" as const,
      },
      withCurrentPolicy: vi.fn(),
      withHeldScopePolicy: vi.fn(),
    },
    source = createCurrentProductUniqueScopeSource({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      validationAuthority,
      historyAuthority,
      tenantAuthority,
      policySource,
      clock: { now: () => at },
    }),
    tx = { query: vi.fn() };
  return { source, tx, validationAuthority, historyAuthority, tenantAuthority, policySource };
}
it("current history denial precedes private SQL, Tenant, policy and consumer work", async () => {
  const f = fixture(),
    work = vi.fn();
  await expect(f.source.withCurrentAssessment(f.tx, input(), work)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(f.tx.query).not.toHaveBeenCalled();
  expect(f.tenantAuthority.withCurrentBrandReferenceRead).not.toHaveBeenCalled();
  expect(f.policySource.withCurrentPolicy).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it.each(["command", "policyReference", "policyVersion"])(
  "rejects %s accessors before acquisition",
  async (key) => {
    const f = fixture(),
      getter = vi.fn(),
      value = Object.defineProperty(input(), key, { get: getter });
    await expect(f.source.withCurrentAssessment(f.tx, value, vi.fn())).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.historyAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  },
);
it.each(["tenantReference", "brandReference", "actorReference"] as const)(
  "requires exact current %s",
  async (key) => {
    const f = fixture(),
      value = input();
    value.command[key] = id(99);
    await expect(f.source.withCurrentAssessment(f.tx, value, vi.fn())).rejects.toThrow();
    expect(f.historyAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  },
);
it("does not accept a supplied roster or fixed group mapping", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentAssessment(f.tx, { ...input(), stores: [], groups: {} }, vi.fn()),
  ).rejects.toThrow();
  expect(f.historyAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
});
it("does not turn a missing SQL source into a passing check", async () => {
  const f = fixture();
  f.historyAuthority.holdUntilTransactionCompletes.mockResolvedValue(undefined);
  await expect(f.source.withCurrentAssessment(f.tx, input(), vi.fn())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.tenantAuthority.withCurrentBrandReferenceRead).not.toHaveBeenCalled();
});

it("does not let history access substitute for current Validate action/field authority", async () => {
  const f = fixture();
  f.validationAuthority.holdUntilTransactionCompletes.mockRejectedValue(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await expect(f.source.withCurrentAssessment(f.tx, input(), vi.fn())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(f.tx.query).not.toHaveBeenCalled();
  expect(f.historyAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
});
