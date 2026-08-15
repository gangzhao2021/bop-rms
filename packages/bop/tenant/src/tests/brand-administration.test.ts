import { describe, expect, it, vi } from "vitest";
import {
  BrandAdministrationError,
  createBrand,
  createBrandAdministrationService,
  createBrandConfigurationVersion,
  createBrandInheritanceCandidate,
  createBrandStoreMembershipRecord,
  resolveBrandInheritance,
  type Brand,
  type BrandAdministrationOperation,
  type BrandAdministrationPorts,
  type BrandConfigurationVersion,
  type BrandStoreMembershipRecord,
  type Store,
} from "../index.js";
const id = (n: number) => `018f9e70-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  AT = "2026-08-15T14:00:00.000Z",
  LATER = "2026-08-15T14:01:00.000Z";
const brandShape = (o: Record<string, unknown> = {}) => ({
  brandReference: id(1),
  code: "NORTH",
  displayName: "Synthetic North",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Draft",
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  ...o,
});
const configShape = (o: Record<string, unknown> = {}) => ({
  configurationVersionReference: id(10),
  brandReference: id(1),
  configurationVersion: 1,
  lifecycle: "Draft",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  mediaThemeReference: id(11),
  catalogSourceReference: id(12),
  platformTemplateReference: id(13),
  overrideAllowedFieldCodes: ["DISPLAY.THEME"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: AT,
  effectiveUntil: null,
  supersedesVersionReference: null,
  reasonCode: "INITIAL_CONFIGURATION",
  authoredByReference: id(20),
  approvedByReference: null,
  approvalEvidenceReference: null,
  publicationReference: null,
  createdAt: AT,
  updatedAt: AT,
  dataClassification: "ConfigurationMetadata",
  ...o,
});
const command = (artifact: unknown, expectedBrandVersion: number, operation = 30, actor = 20) => ({
  operationReference: id(operation),
  actorReference: id(actor),
  purposeCode: "BRAND.ADMINISTRATION",
  auditReference: id(operation + 1),
  expectedBrandVersion,
  occurredAt: LATER,
  artifact,
});
function harness(initial: Brand | null = createBrand(brandShape())) {
  let brand = initial,
    config: BrandConfigurationVersion | null = null,
    membership: BrandStoreMembershipRecord | null = null;
  const operations = new Map<string, BrandAdministrationOperation>();
  const store = createBrand({ ...brandShape(), brandReference: id(2) }) as unknown as Store;
  const ports: BrandAdministrationPorts = {
    authorization: { authorize: vi.fn(async () => true) },
    approval: { validate: vi.fn(async () => true) },
    publishing: { validate: vi.fn(async () => true) },
    references: {
      validateMedia: vi.fn(async () => true),
      validateCatalog: vi.fn(async () => true),
      hashIntent: (v) => `digest:${v}`,
      equals: (a, b) => a === b,
    },
    repository: {
      loadBrand: vi.fn(async () => brand),
      loadStore: vi.fn(
        async () =>
          ({
            ...store,
            storeReference: id(3),
            brandReference: id(1),
            timeZone: "America/Toronto",
            locale: "en-CA",
          }) as Store,
      ),
      loadLatestConfiguration: vi.fn(async () => config),
      loadLatestMembership: vi.fn(async () => membership),
      resolveOperation: vi.fn(async (r) => operations.get(r) ?? null),
      commit: vi.fn(async ({ operation }) => {
        operations.set(operation.operationReference, operation);
        if ("code" in operation.artifact) brand = operation.artifact;
        if ("configurationVersion" in operation.artifact) config = operation.artifact;
        if ("membershipRecordReference" in operation.artifact) membership = operation.artifact;
        return operation;
      }),
    },
  };
  return {
    ports,
    service: createBrandAdministrationService(ports),
    setConfig(v: BrandConfigurationVersion) {
      config = v;
    },
    setMembership(v: BrandStoreMembershipRecord | null) {
      membership = v;
    },
  };
}
describe("WP-2191 Brand administration", () => {
  it("enforces locale, approval, supersession and hard-requirement shapes", () => {
    expect(createBrandConfigurationVersion(configShape()).supportedLocales).toEqual([
      "en-CA",
      "fr-CA",
    ]);
    for (const value of [
      { ...configShape(), supportedLocales: ["fr-CA"] },
      { ...configShape(), hardRequirementFieldCodes: ["DISPLAY.THEME"] },
      { ...configShape({ lifecycle: "Approved" }), approvedByReference: null },
    ])
      expect(() => createBrandConfigurationVersion(value)).toThrow(BrandAdministrationError);
  });
  it("resolves one compatible allowed override and rejects hard or ambiguous matches", () => {
    const config = createBrandConfigurationVersion(configShape()),
      candidate = createBrandInheritanceCandidate({
        candidateReference: id(40),
        fieldCode: "DISPLAY.THEME",
        source: "StoreOverride",
        sourceVersionReference: id(41),
        baseBrandVersionReference: id(10),
        valueReference: id(42),
        priority: 10,
        effectiveFrom: AT,
        effectiveUntil: null,
        platformHardRequirement: false,
      });
    expect(resolveBrandInheritance(config, [candidate], "DISPLAY.THEME", AT).source).toBe(
      "StoreOverride",
    );
    expect(() =>
      resolveBrandInheritance(
        config,
        [{ ...candidate, fieldCode: "SECURITY.REAUTH" }],
        "SECURITY.REAUTH",
        AT,
      ),
    ).toThrowError(/invalid/u);
    expect(() =>
      resolveBrandInheritance(
        config,
        [candidate, createBrandInheritanceCandidate({ ...candidate, candidateReference: id(43) })],
        "DISPLAY.THEME",
        AT,
      ),
    ).toThrow();
  });
  it("creates a Draft Brand and reauthorizes idempotent replay", async () => {
    const context = harness(null),
      input = command(createBrand(brandShape()), 0);
    await expect(context.service.createBrand(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(context.service.createBrand(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    expect(context.ports.authorization.authorize).toHaveBeenCalledTimes(2);
  });
  it("runs Draft -> Pending -> Approved -> Published with independent evidence", async () => {
    const context = harness(),
      draft = createBrandConfigurationVersion(configShape());
    await context.service.saveConfigurationDraft(command(draft, 1));
    const pending = createBrandConfigurationVersion({
      ...draft,
      lifecycle: "PendingApproval",
      updatedAt: LATER,
    });
    await context.service.submitConfiguration(command(pending, 1, 32));
    const approved = createBrandConfigurationVersion({
      ...pending,
      lifecycle: "Approved",
      approvedByReference: id(21),
      approvalEvidenceReference: id(22),
    });
    await context.service.approveConfiguration(command(approved, 1, 34, 21));
    const published = createBrandConfigurationVersion({
      ...approved,
      lifecycle: "Published",
      publicationReference: id(23),
    });
    await expect(
      context.service.publishConfiguration(command(published, 1, 36, 21)),
    ).resolves.toMatchObject({ status: "Applied" });
    expect(context.ports.publishing.validate).toHaveBeenCalledOnce();
  });
  it("rejects permission revocation and unavailable Media/Catalog references", async () => {
    const denied = harness();
    (denied.ports.authorization.authorize as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(
      denied.service.saveConfigurationDraft(
        command(createBrandConfigurationVersion(configShape()), 1),
      ),
    ).rejects.toMatchObject({ code: "BRAND_ADMIN_PERMISSION_DENIED" });
    const invalid = harness();
    (invalid.ports.references.validateCatalog as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(
      invalid.service.saveConfigurationDraft(
        command(createBrandConfigurationVersion(configShape()), 1),
      ),
    ).rejects.toMatchObject({ code: "BRAND_ADMIN_REFERENCE_INVALID" });
  });
  it("records only same-Brand non-duplicate Store membership with approval", async () => {
    const context = harness(),
      record = createBrandStoreMembershipRecord({
        membershipRecordReference: id(50),
        brandReference: id(1),
        storeReference: id(3),
        action: "Added",
        effectiveAt: AT,
        brandVersion: 1,
        actorReference: id(20),
        approvalEvidenceReference: id(51),
        operationReference: id(52),
        recordedAt: LATER,
      });
    await expect(context.service.addStoreMembership(command(record, 1, 53))).resolves.toMatchObject(
      { status: "Applied" },
    );
    await expect(
      context.service.addStoreMembership(
        command(
          { ...record, membershipRecordReference: id(54), operationReference: id(55) },
          1,
          56,
        ),
      ),
    ).rejects.toMatchObject({ code: "BRAND_ADMIN_MEMBERSHIP_INVALID" });
    context.setMembership(record);
    const removed = createBrandStoreMembershipRecord({
      ...record,
      membershipRecordReference: id(57),
      operationReference: id(58),
      action: "Removed",
    });
    await expect(
      context.service.removeStoreMembership(command(removed, 1, 59)),
    ).resolves.toMatchObject({ status: "Applied" });
  });
});
