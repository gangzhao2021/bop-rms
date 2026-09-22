import process from "node:process";
import { createHash } from "node:crypto";
import { createEffectivePeriod } from "../../packages/bop/effective-period/src/index.ts";
import { entryTorontoBoundary } from "./pilot-toronto-boundary.mjs";
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
  const id = (n) => "0190fa24-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
    versionReference: id(11),
    ...scope,
    stableCode: "DEMO_STORE_TAX",
    aggregateVersion: 1,
    versionNumber: 1,
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
      ruleReference: id(18 + index),
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
    createdAt: at,
  };
  const digest = hash(tax);
  const taxConfiguration = {
    ...tax,
    snapshotDigest: digest,
    professionalEvidence: {
      evidenceReference: id(15),
      snapshotReference: id(11),
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
