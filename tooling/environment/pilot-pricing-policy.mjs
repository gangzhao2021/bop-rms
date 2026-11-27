import process from "node:process";
import { createHash } from "node:crypto";
import { createEffectivePeriod } from "../../packages/bop/effective-period/src/index.ts";
import { entryTorontoBoundary } from "./pilot-toronto-boundary.mjs";

/** The installation Store's synthetic identities. */
const INSTALLATION_PREFIX = "0190fa24";
const syntheticId = (prefix, n) => prefix + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const fixtureId = (n) => syntheticId(INSTALLATION_PREFIX, n);
/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-10-31): a served TEST Store's
 * own synthetic tax identities (`tax` in pilot-internal-test-store-open), the same shape as the
 * installation Store's under a prefix derived from the Store: the same on every run, never the
 * installation's, and recognisably synthetic (`…-0000-7000-8000-…`).
 */
export function servedStoreTaxPrefix(storeReference) {
  const digest = createHash("sha256")
    .update("InternalTestStoreTax:" + storeReference)
    .digest("hex");
  return digest.slice(0, 8) === INSTALLATION_PREFIX ? digest.slice(8, 16) : digest.slice(0, 8);
}
/**
 * Identities of the synthetic DEMO tax version `versionNumber`: version 1 is the installed one;
 * each Owner-approved InternalTest renewal (pilot-internal-test-renew) appends the next version
 * with its own fixture identities, so every version of the authority stays distinguishable.
 * `prefix` is the Store's (the installation Store's when absent).
 */
export function internalTestTaxVersionIdentity(versionNumber, prefix = INSTALLATION_PREFIX) {
  if (
    !Number.isSafeInteger(versionNumber) ||
    versionNumber < 1 ||
    versionNumber > 4095 ||
    !/^[0-9a-f]{8}$/u.test(prefix)
  )
    throw new Error("INTERNAL_PRICING_ONLY");
  const base = versionNumber === 1 ? 0 : versionNumber * 0x10000;
  return {
    versionReference: syntheticId(prefix, base + 11),
    ruleReferences: ["Pickup", "DineIn"].map((_, index) => syntheticId(prefix, base + 18 + index)),
  };
}
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const instant = (value) =>
  typeof value === "string" && INSTANT.test(value) && new Date(value).toISOString() === value;
/**
 * Whose synthetic tax configuration the profile names: the installation Store's (created with the
 * profile), or — `storeTaxConfiguration` — a served TEST Store's own, created at its `createdAt`.
 */
function taxOriginOf(profile) {
  const own = profile.storeTaxConfiguration;
  if (own === undefined) return { prefix: INSTALLATION_PREFIX, createdAt: profile.createdAt };
  if (
    own === null ||
    typeof own !== "object" ||
    Object.keys(own).join() !== "createdAt" ||
    !instant(own.createdAt) ||
    own.createdAt < profile.createdAt
  )
    throw new Error("INTERNAL_PRICING_ONLY");
  return {
    prefix: servedStoreTaxPrefix(profile.binding.storeReference),
    createdAt: own.createdAt,
  };
}
/** The profile's renewed tax version (absent: version 1, created with the configuration). */
function taxVersionOf(profile, origin) {
  const renewed = profile.taxConfigurationVersion;
  if (renewed === undefined) return { versionNumber: 1, createdAt: origin.createdAt };
  if (
    renewed === null ||
    typeof renewed !== "object" ||
    Object.keys(renewed).sort().join() !== "createdAt,versionNumber" ||
    !Number.isSafeInteger(renewed.versionNumber) ||
    renewed.versionNumber < 2 ||
    !instant(renewed.createdAt) ||
    renewed.createdAt < origin.createdAt
  )
    throw new Error("INTERNAL_PRICING_ONLY");
  return { versionNumber: renewed.versionNumber, createdAt: renewed.createdAt };
}
/** Existing synthetic InternalTest fixture only; never legal or real Store tax evidence. */
export async function createInternalPricingPolicy({ loadProfile, loadMenu, expectedDatabaseName }) {
  if (
    process.env.NODE_ENV !== "development" ||
    typeof expectedDatabaseName !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(expectedDatabaseName)
  )
    throw new Error("INTERNAL_PRICING_ONLY");
  const profile = await loadProfile();
  const menu = await loadMenu();
  if (
    [profile, menu].some(
      (v) => v?.environment !== "InternalTest" || v.database !== expectedDatabaseName,
    )
  )
    throw new Error("INTERNAL_PRICING_ONLY");
  const id = fixtureId;
  const hash = (value) =>
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)))
      .digest("hex");
  const scope = {
    brandReference: profile.binding.brandReference,
    storeReference: profile.binding.storeReference,
  };
  const at = profile.createdAt,
    validUntil = profile.binding.validUntil;
  const taxOrigin = taxOriginOf(profile);
  const taxId = (n) => syntheticId(taxOrigin.prefix, n);
  const taxVersion = taxVersionOf(profile, taxOrigin);
  const taxIdentity = internalTestTaxVersionIdentity(taxVersion.versionNumber, taxOrigin.prefix);
  const effectivePeriod = createEffectivePeriod({
    timeZone: "America/Toronto",
    effectiveFrom: entryTorontoBoundary(at),
    effectiveUntil: null,
  });
  const meta = {
    currencyCode: "CAD",
    minorUnitExponent: 2,
    metadataVersion: 1,
    metadataVersionReference: id(90),
  };
  const currencyMetadata = { ...meta, metadataDigest: hash(meta) };
  const price = {
    priceBookReference: id(1),
    versionReference: id(2),
    brandReference: scope.brandReference,
    stableCode: "DEMO_CAD_BASE",
    aggregateVersion: 1,
    versionNumber: 1,
    lifecycle: "Published",
    currencyMetadata,
    entries: [
      {
        entryReference: id(4),
        sellableReference: menu.skuReference,
        scopeKind: "Brand",
        scopeReference: null,
        channelCode: null,
        orderType: null,
        amount: { amountMinor: 1000n, currencyCode: "CAD" },
        effectivePeriod,
        reasonCode: "SYNTHETIC_BASE",
      },
    ],
    createdAt: at,
  };
  const priceBook = { ...price, snapshotDigest: hash(price) };
  // The tax configuration's period starts with its own creation (the installation's, or the
  // served TEST Store's).
  const taxEffectivePeriod =
    taxOrigin.createdAt === at
      ? effectivePeriod
      : createEffectivePeriod({
          timeZone: "America/Toronto",
          effectiveFrom: entryTorontoBoundary(taxOrigin.createdAt),
          effectiveUntil: null,
        });
  const tax = {
    configurationReference: taxId(10),
    versionReference: taxIdentity.versionReference,
    ...scope,
    stableCode: "DEMO_STORE_TAX",
    aggregateVersion: taxVersion.versionNumber,
    versionNumber: taxVersion.versionNumber,
    lifecycle: "Published",
    jurisdictionCode: "CA-ON",
    currencyMetadata,
    effectivePeriod: taxEffectivePeriod,
    registrationEvidence: {
      applicabilityReference: taxId(12),
      operatingEntityTaxReference: taxId(13),
      jurisdictionProfileReference: taxId(14),
      status: "Verified",
      validUntil,
    },
    rules: ["Pickup", "DineIn"].map((orderType, index) => ({
      ruleReference: taxIdentity.ruleReferences[index],
      taxClassificationReference: menu.taxClassificationReference,
      orderType,
      chargeType: "Sellable",
      taxComponentCode: "SYNTHETIC_TAX",
      treatment: "Taxable",
      rate: "0.13",
      priceInclusion: "Exclusive",
      roundingMode: "HalfUp",
      calculationOrder: 1,
      compoundOnPriorTax: false,
      exceptionEvidenceReference: null,
      receiptPresentationCode: "SYNTHETIC_TAX_LINE",
    })),
    createdAt: taxVersion.createdAt,
  };
  const digest = hash(tax);
  const taxConfiguration = {
    ...tax,
    snapshotDigest: digest,
    professionalEvidence: {
      evidenceReference: taxId(15),
      snapshotReference: taxIdentity.versionReference,
      snapshotDigest: digest,
      professionalReviewReference: taxId(16),
      fixtureSuiteReference: taxId(17),
      fixtureSuiteDigest: hash("INTERNAL_TEST_ONLY"),
      result: "Pass",
      reviewedAt: taxOrigin.createdAt,
      validUntil,
    },
  };
  return {
    scope,
    currencyMetadata,
    priceBook,
    taxConfiguration,
    actorReference: id(99),
    taxClassificationReference: menu.taxClassificationReference,
    validUntil,
  };
}
