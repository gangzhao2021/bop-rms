import process from "node:process";
import { createHash } from "node:crypto";
import { createEffectivePeriod } from "../../packages/bop/effective-period/src/index.ts";
import { entryTorontoBoundary } from "./pilot-toronto-boundary.mjs";

const fixtureId = (n) => "0190fa24-0000-7000-8000-" + n.toString(16).padStart(12, "0");
/**
 * Identities of the synthetic DEMO tax version `versionNumber`: version 1 is the installed one;
 * each Owner-approved InternalTest renewal (pilot-internal-test-renew) appends the next version
 * with its own fixture identities, so every version of the authority stays distinguishable.
 */
export function internalTestTaxVersionIdentity(versionNumber) {
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1 || versionNumber > 4095)
    throw new Error("INTERNAL_PRICING_ONLY");
  const base = versionNumber === 1 ? 0 : versionNumber * 0x10000;
  return {
    versionReference: fixtureId(base + 11),
    ruleReferences: ["Pickup", "DineIn"].map((_, index) => fixtureId(base + 18 + index)),
  };
}
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
/** The profile's renewed tax version (absent: the installed version 1, created with the profile). */
function taxVersionOf(profile) {
  const renewed = profile.taxConfigurationVersion;
  if (renewed === undefined) return { versionNumber: 1, createdAt: profile.createdAt };
  if (
    renewed === null ||
    typeof renewed !== "object" ||
    Object.keys(renewed).sort().join() !== "createdAt,versionNumber" ||
    !Number.isSafeInteger(renewed.versionNumber) ||
    renewed.versionNumber < 2 ||
    typeof renewed.createdAt !== "string" ||
    !INSTANT.test(renewed.createdAt) ||
    new Date(renewed.createdAt).toISOString() !== renewed.createdAt ||
    renewed.createdAt < profile.createdAt
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
  const taxVersion = taxVersionOf(profile);
  const taxIdentity = internalTestTaxVersionIdentity(taxVersion.versionNumber);
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
  const tax = {
    configurationReference: id(10),
    versionReference: taxIdentity.versionReference,
    ...scope,
    stableCode: "DEMO_STORE_TAX",
    aggregateVersion: taxVersion.versionNumber,
    versionNumber: taxVersion.versionNumber,
    lifecycle: "Published",
    jurisdictionCode: "CA-ON",
    currencyMetadata,
    effectivePeriod,
    registrationEvidence: {
      applicabilityReference: id(12),
      operatingEntityTaxReference: id(13),
      jurisdictionProfileReference: id(14),
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
      evidenceReference: id(15),
      snapshotReference: taxIdentity.versionReference,
      snapshotDigest: digest,
      professionalReviewReference: id(16),
      fixtureSuiteReference: id(17),
      fixtureSuiteDigest: hash("INTERNAL_TEST_ONLY"),
      result: "Pass",
      reviewedAt: at,
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
