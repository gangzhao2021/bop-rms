import {
  buildPriceBookReferenceSourceSnapshot,
  buildOptionPriceReferenceSourceSnapshot,
  buildPromotionReferenceSourceSnapshot,
  type PriceBookReferenceSourceRequest,
} from "../index.js";
export const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
export const at = "2026-09-29T12:00:00.000Z",
  past = "2026-08-01T00:00:00.000Z";
export const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: `sha256:${"a".repeat(64)}`,
};
export function fixture(input: PriceBookReferenceSourceRequest = request) {
  const target = {
    mappingProfile: "CurrentDraftBindings" as const,
    catalogSourceDigest: `sha256:${"b".repeat(64)}`,
    productReference: id(10),
    skuReference: null,
    skuReferences: [id(11), id(12)],
    categoryReferences: [id(13)],
    bindings: [
      {
        bindingReference: id(20),
        enabledOptionReferences: [id(21)],
        includedSkuReferences: [id(11)],
        excludedSkuReferences: [id(12)],
        channelCodes: ["CUSTOMER_PWA"],
      },
    ],
  };
  const priceBooks = buildPriceBookReferenceSourceSnapshot(
    {
      observedAt: at,
      references: [
        {
          precise: true,
          reference: {
            priceBookReference: id(100),
            brandReference: id(1),
            aggregateVersion: 1,
            currentVersionReference: id(101),
            updatedAt: past,
            versionReference: id(101),
            versionNumber: 1,
            snapshotDigest: `sha256:${"c".repeat(64)}`,
            lifecycle: "Archived",
            createdAt: past,
            entryReference: id(102),
            sellableReference: id(11),
            scopeKind: "Store",
            scopeReference: id(103),
            channelCode: "DINE_IN",
            orderType: "DineIn",
            timeZone: "America/Toronto",
            effectiveFrom: past,
            effectiveUntil: at,
          },
        },
      ],
    },
    input,
    at,
  );
  const root = {
    ruleReference: id(200),
    brandReference: id(1),
    bindingReference: id(20),
    optionReference: id(21),
    aggregateVersion: "1",
    currentVersionReference: id(201),
    rootCreatedAt: past,
    updatedAt: past,
  };
  const version = {
    versionReference: id(201),
    versionNumber: "1",
    snapshotDigest: `sha256:${"d".repeat(64)}`,
    lifecycle: "Published",
    skuReference: null,
    scopeKind: "Region",
    scopeReference: id(202),
    channelCode: "DINE_IN",
    orderType: "DineIn",
    timeZone: "UTC",
    effectiveFrom: "2026-10-01T00:00:00.000Z",
    effectiveUntil: null,
    createdAt: past,
  };
  const optionPrices = buildOptionPriceReferenceSourceSnapshot(
    {
      observedAt: at,
      references: [
        { root, version, precise: true },
        {
          root: {
            ...root,
            ruleReference: id(210),
            bindingReference: id(999),
            currentVersionReference: null,
          },
          version: null,
          precise: true,
        },
      ],
    },
    input,
    at,
  );
  const promoRoot = {
    promotionReference: id(300),
    brandReference: id(1),
    aggregateVersion: 1,
    currentVersionReference: id(301),
    rootCreatedAt: past,
    updatedAt: past,
  };
  const promoVersion = {
    versionReference: id(301),
    versionNumber: 1,
    snapshotDigest: `sha256:${"e".repeat(64)}`,
    lifecycle: "Paused",
    promotionType: "ItemPercentage",
    benefitScope: "Item",
    timeZone: "UTC",
    effectiveFrom: past,
    effectiveUntil: null,
    createdAt: past,
    eligibility: [
      { eligibilityReference: id(302), referenceKind: "Category", publicReference: id(13) },
      { eligibilityReference: id(303), referenceKind: "Segment", publicReference: id(14) },
    ],
  };
  const promotions = buildPromotionReferenceSourceSnapshot(
    {
      observedAt: at,
      references: [
        { root: promoRoot, version: promoVersion, precise: true },
        {
          root: { ...promoRoot, promotionReference: id(310), currentVersionReference: id(311) },
          version: {
            ...promoVersion,
            versionReference: id(311),
            lifecycle: "Draft",
            eligibility: [],
          },
          precise: true,
        },
        {
          root: { ...promoRoot, promotionReference: id(320), currentVersionReference: id(321) },
          version: {
            ...promoVersion,
            versionReference: id(321),
            lifecycle: "Archived",
            benefitScope: "Order",
            eligibility: [
              {
                eligibilityReference: id(322),
                referenceKind: "Sellable",
                publicReference: id(999),
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
  return { request: input, target, priceBooks, optionPrices, promotions, now: at };
}
