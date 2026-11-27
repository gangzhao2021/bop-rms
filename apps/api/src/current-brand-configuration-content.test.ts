import { expect, it, vi } from "vitest";
import {
  createCurrentBrandConfigurationContentSource,
  createCurrentOptionSetBrandConfigurationContentSource,
  createCurrentStoreBrandConfigurationContentSource,
} from "./current-brand-configuration-content.js";
import {
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContentDigest,
  type TenantRecordedBrandConfiguration,
} from "@bop/tenant";

const publishing = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@bop/publishing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: () => ({
    resolveCurrentReleaseForReference: publishing.resolve,
  }),
}));

it("refuses malformed observation before acquiring owning sources", async () => {
  const withRecordedConfiguration = vi.fn();
  const source = createCurrentBrandConfigurationContentSource({ withRecordedConfiguration });
  const getter = vi.fn(() => "unrestricted");
  const input = Object.defineProperty({}, "brandReference", { get: getter });
  const work = vi.fn();
  await expect(source.withCurrentContent(input as never, work)).rejects.toThrow(
    "CURRENT_BRAND_CONFIGURATION_UNAVAILABLE",
  );
  expect(withRecordedConfiguration).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it("does not replace an unavailable actual owning source with defaults", async () => {
  const withRecordedConfiguration = vi.fn(async () => {
    throw new Error("synthetic unavailable owner");
  });
  const source = createCurrentBrandConfigurationContentSource({ withRecordedConfiguration });
  const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const work = vi.fn();
  await expect(
    source.withCurrentContent(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(20),
        purposeCode: "CATALOG_PRODUCT_CONTENT",
        configurationVersionReference: id(10),
        expectedBrandVersion: 1,
        originalIntentDigest: "sha256:" + "a".repeat(64),
        observedAt: "2026-09-11T10:00:00.000Z",
        validUntil: "2026-09-11T10:00:30.000Z",
      },
      work,
    ),
  ).rejects.toThrow("CURRENT_BRAND_CONFIGURATION_UNAVAILABLE");
  expect(work).not.toHaveBeenCalled();
});

const optionId = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const optionRequest = {
  tenantReference: optionId(1),
  brandReference: optionId(2),
  actorReference: optionId(20),
  purposeCode: "CATALOG_OPTION_SET_PUBLICATION" as const,
  configurationVersionReference: optionId(10),
  expectedBrandVersion: 1,
  originalIntentDigest: "sha256:" + "a".repeat(64),
  observedAt: "2026-09-11T10:00:00.000Z",
  validUntil: "2026-09-11T10:00:05.000Z",
  optionSetReference: optionId(30),
  versionReference: optionId(31),
  expectedAggregateVersion: 1,
  sourceDigest: "sha256:" + "b".repeat(64),
  contentDigest: "sha256:" + "c".repeat(64),
  configurationDigest: "sha256:" + "d".repeat(64),
  graphDigest: "sha256:" + "e".repeat(64),
  activationAt: "2026-09-11T10:00:00.000Z",
};
it("acquires owning Brand content with the exact Option intent and propagates unavailable evidence", async () => {
  const withRecordedConfiguration = vi.fn(async (input: typeof optionRequest) => {
    void input;
    throw new Error("SYNTHETIC_UNAVAILABLE");
  });
  const source = createCurrentOptionSetBrandConfigurationContentSource({
    withRecordedConfiguration,
  });
  const work = vi.fn();
  await expect(source.withCurrentContent(optionRequest, work)).rejects.toThrow(
    "CURRENT_BRAND_CONFIGURATION_UNAVAILABLE",
  );
  expect(withRecordedConfiguration.mock.calls[0]?.[0]).toEqual(optionRequest);
  expect(work).not.toHaveBeenCalled();
});
it.each([
  { purposeCode: "CATALOG_PRODUCT_CONTENT" },
  { graphDigest: "unbound" },
  { validUntil: "2026-09-11T10:00:05.001Z" },
  { extra: true },
])("rejects Option source substitutions before querying owners %#", async (patch) => {
  const withRecordedConfiguration = vi.fn(),
    work = vi.fn();
  const source = createCurrentOptionSetBrandConfigurationContentSource({
    withRecordedConfiguration,
  });
  await expect(
    source.withCurrentContent({ ...optionRequest, ...patch } as never, work),
  ).rejects.toThrow("CURRENT_BRAND_CONFIGURATION_UNAVAILABLE");
  expect(withRecordedConfiguration).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

const storeRequest = {
  tenantReference: optionId(1),
  brandReference: optionId(2),
  actorReference: optionId(20),
  purposeCode: "STORE_CONFIGURATION" as const,
  configurationVersionReference: optionId(10),
  expectedBrandVersion: 1,
  originalIntentDigest: "sha256:" + "a".repeat(64),
  observedAt: "2026-09-11T10:00:00.000Z",
  validUntil: "2026-09-11T10:00:05.000Z",
};
function storeFixture() {
  const c = parseTenantRecordedBrandConfiguration({
    configurationVersionReference: optionId(10),
    brandReference: optionId(2),
    configurationVersion: 1,
    lifecycle: "Published",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA"],
    mediaThemeReference: null,
    catalogSourceReference: optionId(12),
    platformTemplateReference: optionId(13),
    overrideAllowedFieldCodes: [],
    hardRequirementFieldCodes: [],
    effectiveFrom: storeRequest.observedAt,
    effectiveUntil: null,
    supersedesVersionReference: null,
    reasonCode: "INITIAL_CONFIGURATION",
    authoredByReference: optionId(20),
    approvedByReference: optionId(21),
    approvalEvidenceReference: optionId(22),
    publicationReference: optionId(23),
    createdAt: storeRequest.observedAt,
    updatedAt: storeRequest.observedAt,
    dataClassification: "ConfigurationMetadata",
  });
  const packet: TenantRecordedBrandConfiguration = Object.freeze({
    profile: "TenantRecordedBrandConfigurationV1",
    configuration: c,
    brandVersion: 1,
    contentDigest: tenantBrandConfigurationContentDigest(c),
    observedAt: storeRequest.observedAt,
    validUntil: storeRequest.validUntil,
    currentPublication: "NotEvaluated",
  });
  const tx = { query: vi.fn() };
  const captured: unknown[] = [];
  const recorded: Parameters<typeof createCurrentStoreBrandConfigurationContentSource>[0] = {
    async withRecordedConfiguration(input, work) {
      captured.push(input);
      return work(packet, tx);
    },
  };
  const proof = {
    recorded: {
      release: {
        snapshotReference: c.configurationVersionReference,
        snapshotDigest: packet.contentDigest,
        createdAt: storeRequest.observedAt,
      },
      validationEvidence: { checkedAt: storeRequest.observedAt },
      approvalEvidence: {
        approvedAt: storeRequest.observedAt,
        evidenceReference: c.approvalEvidenceReference,
        approvedActorReference: c.approvedByReference,
      },
    },
    current: { release: { releaseId: optionId(24) } },
  };
  publishing.resolve.mockReset().mockResolvedValue(proof);
  return {
    source: createCurrentStoreBrandConfigurationContentSource(recorded),
    captured,
    proof,
    tx,
  };
}
it("reads the exact Store-purpose Brand through both owning metadata and current release proof", async () => {
  const f = storeFixture();
  const work = vi.fn(async () => "read");
  await expect(f.source.withCurrentContent(storeRequest, work)).resolves.toBe("read");
  expect(f.captured).toEqual([storeRequest]);
  expect(publishing.resolve).toHaveBeenCalledWith({
    publicationReference: optionId(23),
    configurationType: "BRAND_CONFIGURATION",
    purposeCode: "BRAND_CONFIGURATION",
    observedAt: storeRequest.observedAt,
  });
  expect(work).toHaveBeenCalledWith(
    expect.objectContaining({
      currentPublicationReference: optionId(24),
      originalPublicationReference: optionId(23),
      configurationVersionReference: optionId(10),
      eligibility: "NotEvaluated",
    }),
    f.tx,
  );
});
it("does not treat a recorded Published Brand with a mismatched release digest as proof", async () => {
  const f = storeFixture();
  f.proof.recorded.release.snapshotDigest = "sha256:" + "b".repeat(64);
  const work = vi.fn();
  await expect(f.source.withCurrentContent(storeRequest, work)).rejects.toThrow(
    "CURRENT_BRAND_CONFIGURATION_UNAVAILABLE",
  );
  expect(work).not.toHaveBeenCalled();
});
it.each([
  { purposeCode: "CATALOG_PRODUCT_CONTENT" },
  { purposeCode: "CATALOG_OPTION_SET_PUBLICATION" },
  { validUntil: "2026-09-11T10:00:05.001Z" },
  { extra: true },
])("refuses substituted Store admission before either owner %#", async (patch) => {
  const f = storeFixture();
  const work = vi.fn();
  await expect(
    f.source.withCurrentContent({ ...storeRequest, ...patch } as never, work),
  ).rejects.toThrow("CURRENT_BRAND_CONFIGURATION_UNAVAILABLE");
  expect(f.captured).toEqual([]);
  expect(publishing.resolve).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
