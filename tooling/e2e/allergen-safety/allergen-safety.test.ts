import { createHash } from "node:crypto";

import {
  CatalogError,
  createMenuAllergenValidationService,
  type MenuAllergenProvenanceSnapshot,
  type MenuAllergenValidationCommand,
} from "../../../packages/rms/catalog/src/index.js";
import {
  buildKitchenAllergenKdsCue,
  createKitchenAllergenAcknowledgement,
  createKitchenAllergenIncidentLink,
  parseKitchenAllergenReview,
  type KitchenAllergenReview,
} from "../../../packages/rms/kitchen/src/index.js";
import { describe, expect, it, vi } from "vitest";

const id = (value: number) => `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const digests = { sha256 };
const at = "2026-08-12T14:00:00.000Z";

function snapshot(): MenuAllergenProvenanceSnapshot {
  return {
    brandReference: id(1) as never,
    menuVersionReference: id(2) as never,
    snapshotDigest: sha256("menu") as never,
    registryVersionReference: id(3) as never,
    defaultLocale: "en-CA",
    registry: [
      {
        allergenReference: id(4) as never,
        code: "MILK" as never,
        localizedNames: { "en-CA": "Milk" },
      },
      {
        allergenReference: id(5) as never,
        code: "PEANUT" as never,
        localizedNames: { "en-CA": "Peanut" },
      },
    ],
    evidence: [
      {
        evidenceReference: id(6) as never,
        subjectReference: id(7) as never,
        subjectKind: "Recipe",
        sourceVersionReference: id(8) as never,
        supplierReference: null,
        documentDigest: sha256("base") as never,
        reviewedAt: at as never,
        validUntil: "2026-08-13T14:00:00.000Z" as never,
        status: "Approved",
        assertions: [{ allergenReference: id(4) as never, classification: "CrossContactPossible" }],
      },
      {
        evidenceReference: id(9) as never,
        subjectReference: id(10) as never,
        subjectKind: "Option",
        sourceVersionReference: id(11) as never,
        supplierReference: id(12) as never,
        documentDigest: sha256("modifier") as never,
        reviewedAt: at as never,
        validUntil: "2026-08-14T14:00:00.000Z" as never,
        status: "Approved",
        assertions: [
          { allergenReference: id(4) as never, classification: "Contains" },
          { allergenReference: id(5) as never, classification: "CrossContactPossible" },
        ],
      },
    ],
    paths: [
      {
        sellableReference: id(13) as never,
        productVersionReference: id(14) as never,
        evidenceReferences: [id(6) as never],
        optionEvidenceReferences: { [id(15)]: [id(9) as never] },
      },
    ],
  };
}

function catalogService(value: MenuAllergenProvenanceSnapshot) {
  return createMenuAllergenValidationService({
    facts: { load: async () => value },
    references: { generate: () => id(16) as never },
  });
}

const command = {
  brandReference: id(1),
  menuVersionReference: id(2),
  snapshotDigest: sha256("menu"),
  requestedAt: at,
} as MenuAllergenValidationCommand;

function review(
  allergenReferences: readonly string[],
  overrides: Record<string, unknown> = {},
): KitchenAllergenReview {
  return parseKitchenAllergenReview({
    reviewReference: id(20),
    brandReference: id(1),
    storeReference: id(21),
    orderReference: id(22),
    ticketReference: id(23),
    orderItemReference: id(24),
    configurationDigest: sha256("configuration-v1"),
    allergenReferences,
    policyVersionReference: id(25),
    recipeVersionReferences: [id(8)],
    reviewerActorReference: id(26),
    outcome: "Accepted",
    reviewedAt: "2026-08-12T14:05:00.000Z",
    validUntil: "2026-08-12T15:05:00.000Z",
    retainUntil: "2028-08-12T14:05:00.000Z",
    classification: "Restricted",
    ...overrides,
  });
}

function paymentEligible(
  value: KitchenAllergenReview,
  configurationDigest: string,
  observedAt: string,
): boolean {
  return !buildKitchenAllergenKdsCue({
    review: value,
    currentConfigurationDigest: configurationDigest,
    observedAt,
    startAcknowledgement: null,
    handoffAcknowledgement: null,
    digests,
  }).executionBlocked;
}

describe("WP-2027 allergen safety E2E", () => {
  it("blocks unknown/conflicting evidence and carries modifier truth through review and Kitchen", async () => {
    const unverified = snapshot();
    const unverifiedBaseEvidence = unverified.evidence[0];
    if (unverifiedBaseEvidence === undefined) throw new Error("synthetic base evidence missing");
    await expect(
      catalogService({
        ...unverified,
        evidence: [
          {
            ...unverifiedBaseEvidence,
            assertions: [{ allergenReference: id(4) as never, classification: "Unverified" }],
          },
          ...unverified.evidence.slice(1),
        ],
      }).validate(command),
    ).rejects.toBeInstanceOf(CatalogError);

    const conflicting = snapshot();
    const conflictingBaseEvidence = conflicting.evidence[0];
    if (conflictingBaseEvidence === undefined) throw new Error("synthetic base evidence missing");
    await expect(
      catalogService({
        ...conflicting,
        evidence: [
          { ...conflictingBaseEvidence, status: "Conflicting" },
          ...conflicting.evidence.slice(1),
        ],
      }).validate(command),
    ).rejects.toBeInstanceOf(CatalogError);

    const validated = await catalogService(snapshot()).validate(command);
    const disclosure = validated.disclosures[id(13)];
    expect(disclosure).toMatchObject({
      allergenFreeClaim: false,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
      items: [
        { allergenReference: id(4), classification: "Contains" },
        { allergenReference: id(5), classification: "CrossContactPossible" },
      ],
    });
    if (disclosure === undefined) throw new Error("synthetic disclosure missing");
    const allergenReferences = disclosure.items.map((item) => item.allergenReference);

    const declined = review(allergenReferences, { outcome: "CannotSafelyAccommodate" });
    expect(paymentEligible(declined, sha256("configuration-v1"), "2026-08-12T14:06:00.000Z")).toBe(
      false,
    );
    expect(() =>
      createKitchenAllergenAcknowledgement({
        acknowledgementReference: id(27),
        review: declined,
        workItemReference: id(28),
        stage: "BeforeStart",
        operatorActorReference: id(29),
        acknowledgedAt: "2026-08-12T14:06:00.000Z",
        configurationDigest: declined.configurationDigest,
        digests,
      }),
    ).toThrowError(expect.objectContaining({ code: "KITCHEN_ALLERGEN_ACCOMMODATION_DENIED" }));

    const accepted = review(allergenReferences);
    const startPayment = vi.fn();
    if (paymentEligible(accepted, accepted.configurationDigest, "2026-08-12T14:06:00.000Z"))
      startPayment();
    expect(startPayment).toHaveBeenCalledTimes(1);
    expect(paymentEligible(accepted, sha256("configuration-v2"), "2026-08-12T14:06:00.000Z")).toBe(
      false,
    );
    expect(paymentEligible(accepted, accepted.configurationDigest, accepted.validUntil)).toBe(
      false,
    );

    const start = createKitchenAllergenAcknowledgement({
      acknowledgementReference: id(27),
      review: accepted,
      workItemReference: id(28),
      stage: "BeforeStart",
      operatorActorReference: id(29),
      acknowledgedAt: "2026-08-12T14:07:00.000Z",
      configurationDigest: accepted.configurationDigest,
      digests,
    });
    const handoff = createKitchenAllergenAcknowledgement({
      acknowledgementReference: id(30),
      review: accepted,
      workItemReference: id(28),
      stage: "BeforeHandoff",
      operatorActorReference: id(31),
      acknowledgedAt: "2026-08-12T14:20:00.000Z",
      configurationDigest: accepted.configurationDigest,
      digests,
    });
    const cue = buildKitchenAllergenKdsCue({
      review: accepted,
      currentConfigurationDigest: accepted.configurationDigest,
      observedAt: "2026-08-12T14:21:00.000Z",
      startAcknowledgement: start,
      handoffAcknowledgement: handoff,
      digests,
    });
    expect(cue).toMatchObject({
      priority: "High",
      nonColorIndicator: true,
      startAcknowledgementRequired: false,
      handoffAcknowledgementRequired: false,
      executionBlocked: false,
    });

    const incident = createKitchenAllergenIncidentLink({
      incidentLinkReference: id(32),
      review: accepted,
      incidentType: "AllergenMismatch",
      configurationSnapshotDigest: accepted.configurationDigest,
      recipeSnapshotDigest: sha256("recipe"),
      handlingSnapshotDigest: sha256("handling"),
      complianceCaseReference: id(33),
      availabilityKillSwitchActionReference: id(34),
      reporterActorReference: id(35),
      reportedAt: "2026-08-12T14:22:00.000Z",
    });
    expect(incident).toMatchObject({
      reviewReference: accepted.reviewReference,
      complianceCaseReference: id(33),
      availabilityKillSwitchActionReference: id(34),
      classification: "Restricted",
    });
    for (const value of [accepted, start, handoff, cue, incident]) {
      expect(Object.hasOwn(value, "medicalNote")).toBe(false);
      expect(Object.hasOwn(value, "customerNote")).toBe(false);
      expect(Object.hasOwn(value, "symptoms")).toBe(false);
    }
  });
});
