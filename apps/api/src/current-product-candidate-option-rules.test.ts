import { expect, it, vi } from "vitest";
import { CatalogError } from "@rms/catalog";
import { createCurrentProductCandidateOptionRuleSource } from "./current-product-candidate-option-rules.js";
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
  };
}

function fixture() {
  const candidateAuthority = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => {
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
    },
    optionAuthority = {
      holdUntilTransactionCompletes: vi.fn(async () => ({
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
      })),
    },
    tx = { query: vi.fn() };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    candidateAuthority,
    optionAuthority,
    clock: { now: () => at },
  };
  return {
    options,
    candidateAuthority,
    optionAuthority,
    tx,
    source: createCurrentProductCandidateOptionRuleSource(options),
  };
}
it("requires current candidate Validate/full fields before SQL or Option history", async () => {
  const x = fixture(),
    work = vi.fn();
  await expect(x.source.withCurrentAssessment(x.tx, input().command, work)).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  expect(x.candidateAuthority.holdUntilTransactionCompletes).toHaveBeenCalledOnce();
  expect(x.optionAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  expect(x.tx.query).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
for (const patch of [
  { actorReference: id(99) },
  { tenantReference: id(99) },
  { brandReference: id(99) },
  { actorKind: "System" },
  { action: "Publish" },
  { extra: true },
  { aggregate: {} },
  { graph: {} },
  { binding: {} },
]) {
  it(`refuses changed command context or supplied content ${Object.keys(patch)[0]}`, async () => {
    const x = fixture();
    await expect(
      x.source.withCurrentAssessment(x.tx, { ...input().command, ...patch }, vi.fn()),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(x.candidateAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
    expect(x.optionAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
    expect(x.tx.query).not.toHaveBeenCalled();
  });
}
it("does not invoke a supplied content getter", async () => {
  const x = fixture(),
    get = vi.fn(() => id(6));
  await expect(
    x.source.withCurrentAssessment(
      x.tx,
      {
        ...input().command,
        get productReference() {
          return get();
        },
      },
      vi.fn(),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(get).not.toHaveBeenCalled();
  expect(x.tx.query).not.toHaveBeenCalled();
});
it("captures configured scope before later options mutation", async () => {
  const x = fixture();
  x.options.actorReference = id(99);
  await expect(
    x.source.withCurrentAssessment(x.tx, input().command, vi.fn()),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(x.candidateAuthority.holdUntilTransactionCompletes).toHaveBeenCalledWith(
    x.tx,
    expect.objectContaining({ actorReference: id(3) }),
  );
});
it("refuses a missing Option authority before source construction", () => {
  const x = fixture();
  expect(() =>
    createCurrentProductCandidateOptionRuleSource({
      ...x.options,
      optionAuthority: undefined as never,
    }),
  ).toThrow(CatalogError);
});
