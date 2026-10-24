import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStoreConfigurationVersion } from "../contracts/store-configuration-administration.js";
import {
  createStoreConfigurationPublicationContent,
  createStoreConfigurationPublicationHash,
} from "../contracts/store-configuration-publication-content.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z";
function configuration(modern = true) {
  const plain = {
    configurationReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(5),
    contactReference: id(6),
    receiptReference: id(7),
    taxConfigurationReference: id(8),
    paymentConfigurationReference: id(9),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({
      isoWeekday: i + 1,
      intervals:
        i === 0
          ? [
              {
                startLocalTime: "09:00:00",
                endLocalTime: "17:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 0,
                leadTimeSeconds: 0,
              },
            ]
          : [],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: id(12),
    publicationReference: id(13),
    liveGateEvidenceReference: id(14),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  return createStoreConfigurationVersion({
    ...plain,
    ...(modern
      ? {
          setupBasis: {
            profile: "StoreSetupConfigurationBasisV2",
            tenantReference: id(16),
            setupDraftReference: id(15),
            sourceRevision: 1,
            sourceSnapshotDigest: `sha256:${"a".repeat(64)}`,
            feeContexts: ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
              chargeType,
              state: "Disabled",
            })),
          },
        }
      : {}),
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) + ":" + canonical(Object.getOwnPropertyDescriptor(value, key)?.value),
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const references = () => ({
  canonicalize: canonical,
  hashIntent: (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`,
});

describe("Store configuration frozen publication content", () => {
  it("keeps the exact legacy full envelope and original full-envelope digest", () => {
    const value = configuration(false),
      refs = references();
    expect(createStoreConfigurationPublicationContent(value)).toEqual(value);
    expect(Object.keys(createStoreConfigurationPublicationContent(value))).toHaveLength(32);
    expect(createStoreConfigurationPublicationHash(refs)(value)).toBe(
      refs.hashIntent(refs.canonicalize(value)),
    );
  });
  it("binds the same V2 content from Submit through a later genuine envelope", () => {
    const published = configuration(),
      hash = createStoreConfigurationPublicationHash(references());
    const draft = {
      ...published,
      lifecycle: "Draft",
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
      liveGateEvidenceReference: null,
    };
    const later = {
      ...published,
      approvedByReference: id(80),
      approvalEvidenceReference: id(81),
      publicationReference: id(82),
      liveGateEvidenceReference: id(83),
      updatedAt: "2026-10-06T10:00:00.000Z",
    };
    expect(hash(draft)).toBe(hash(later));
    const preimage = createStoreConfigurationPublicationContent(draft);
    expect(Object.keys(preimage)).toHaveLength(28);
    expect(preimage).toMatchObject({
      profile: "StoreConfigurationContentV2",
      authoredByReference: published.authoredByReference,
      createdAt: at,
      setupBasis: published.setupBasis,
    });
    for (const key of [
      "lifecycle",
      "approvedByReference",
      "approvalEvidenceReference",
      "publicationReference",
      "liveGateEvidenceReference",
      "updatedAt",
    ])
      expect(preimage).not.toHaveProperty(key);
    expect(Object.isFrozen(preimage)).toBe(true);
  });
  it("changes the digest for authored identity, reason, schedule or setup provenance", () => {
    const value = configuration(),
      hash = createStoreConfigurationPublicationHash(references()),
      original = hash(value);
    expect(hash({ ...value, authoredByReference: id(90) })).not.toBe(original);
    expect(hash({ ...value, reasonCode: "REVISED_REASON" })).not.toBe(original);
    expect(
      hash({
        ...value,
        weeklySchedule: value.weeklySchedule.map((day) => ({ ...day, intervals: [] })),
      }),
    ).not.toBe(original);
    expect(
      hash({
        ...value,
        setupBasis: { ...value.setupBasis, sourceSnapshotDigest: `sha256:${"b".repeat(64)}` },
      }),
    ).not.toBe(original);
  });
  it("rejects forged serialized content, port drift and malformed digest", () => {
    expect(() =>
      createStoreConfigurationPublicationHash({ ...references(), canonicalize: () => "{}" })(
        configuration(),
      ),
    ).toThrow();
    const refs = references(),
      hash = createStoreConfigurationPublicationHash(refs);
    refs.hashIntent = () => `sha256:${"c".repeat(64)}`;
    expect(() => hash(configuration())).toThrow();
    expect(() =>
      createStoreConfigurationPublicationHash({ ...references(), hashIntent: () => "digest" })(
        configuration(),
      ),
    ).toThrow();
  });
  it("never invokes a hash port accessor or accepts an added approval claim", () => {
    const refs = references();
    let called = false;
    Object.defineProperty(refs, "hashIntent", {
      enumerable: true,
      get() {
        called = true;
        return references().hashIntent;
      },
    });
    expect(() => createStoreConfigurationPublicationHash(refs)).toThrow();
    expect(called).toBe(false);
    expect(() =>
      createStoreConfigurationPublicationContent({
        ...configuration(),
        professionalReviewStatus: "Verified",
      }),
    ).toThrow();
  });
});
