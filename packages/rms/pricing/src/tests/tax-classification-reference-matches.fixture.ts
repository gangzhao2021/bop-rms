import {
  buildTaxConfigurationReferenceSourceSnapshot,
  type TaxConfigurationReferenceSourceRequest,
  type ProductVersionTaxReferenceTarget,
} from "../index.js";
import { id, at, past } from "./configuration-reference-matches.fixture.js";
export { id, at };
export const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
  storeReference: id(9),
};
export const hash = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
export function fixture(input: TaxConfigurationReferenceSourceRequest = request) {
  const root = {
    configurationReference: id(4),
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    aggregateVersion: 2,
    currentVersionReference: id(7),
    rootCreatedAt: past,
    updatedAt: past,
  };
  const version = {
    versionReference: id(7),
    versionNumber: 2,
    snapshotDigest: hash(7),
    lifecycle: "Draft",
    timeZone: "America/Toronto",
    effectiveFrom: "2026-10-01T00:00:00.000Z",
    effectiveUntil: null,
    createdAt: past,
    rules: [
      {
        ruleReference: id(101),
        taxClassificationReference: id(12),
        orderType: "DineIn",
        chargeType: "ServiceCharge",
        taxComponentCode: "HST",
      },
    ],
  };
  const taxConfigurations = buildTaxConfigurationReferenceSourceSnapshot(
    {
      observedAt: at,
      references: [
        { root, version, precise: true },
        {
          root,
          version: {
            ...version,
            versionReference: id(6),
            versionNumber: 1,
            lifecycle: "Published",
            effectiveFrom: past,
            effectiveUntil: at,
            rules: [
              {
                ruleReference: id(100),
                taxClassificationReference: id(11),
                orderType: "Pickup",
                chargeType: "Sellable",
                taxComponentCode: "HST",
              },
            ],
          },
          precise: true,
        },
      ],
    },
    input,
    at,
  );
  const target: ProductVersionTaxReferenceTarget = {
    profile: "RecordedDraftConfigurations",
    catalogSourceDigest: hash(99),
    productReference: id(10),
    skuReference: null,
    configurations: [
      {
        catalogConfigurationDigest: hash(1),
        versionReference: id(15),
        skuReferences: [id(11), id(12)],
        taxClassificationReference: null,
      },
      {
        catalogConfigurationDigest: hash(2),
        versionReference: id(15),
        skuReferences: [id(11), id(12)],
        taxClassificationReference: id(11),
      },
      {
        catalogConfigurationDigest: hash(3),
        versionReference: id(15),
        skuReferences: [id(12)],
        taxClassificationReference: id(12),
      },
    ],
  };
  return { request: input, target, taxConfigurations, now: at };
}
