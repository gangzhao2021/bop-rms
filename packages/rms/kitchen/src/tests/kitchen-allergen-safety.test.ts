import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildKitchenAllergenKdsCue,
  createKitchenAllergenAcknowledgement,
  createKitchenAllergenIncidentLink,
  createKitchenAllergenStartAdmission,
  parseKitchenAllergenReview,
} from "../index.js";

const id = (value: number) => `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const digests = { sha256 };

function review(overrides: Record<string, unknown> = {}) {
  return parseKitchenAllergenReview({
    reviewReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    ticketReference: id(5),
    orderItemReference: id(6),
    configurationDigest: sha256("configuration-v1"),
    allergenReferences: [id(7), id(8)],
    policyVersionReference: id(9),
    recipeVersionReferences: [id(10)],
    reviewerActorReference: id(11),
    outcome: "Accepted",
    reviewedAt: "2026-08-11T14:00:00.000Z",
    validUntil: "2026-08-11T15:00:00.000Z",
    retainUntil: "2028-08-11T14:00:00.000Z",
    classification: "Restricted",
    ...overrides,
  });
}

function acknowledgement(value = review(), stage: "BeforeStart" | "BeforeHandoff" = "BeforeStart") {
  return createKitchenAllergenAcknowledgement({
    acknowledgementReference: id(12),
    review: value,
    workItemReference: id(13),
    stage,
    operatorActorReference: id(14),
    acknowledgedAt: "2026-08-11T14:10:00.000Z",
    configurationDigest: value.configurationDigest,
    digests,
  });
}

describe("WP-1407 structured allergen safety", () => {
  it("binds a controlled accepted review and named before-Start acknowledgement to admission", () => {
    const accepted = review();
    const ack = acknowledgement(accepted);
    const decision = createKitchenAllergenStartAdmission({
      review: accepted,
      acknowledgement: ack,
      decisionReference: id(15),
      decisionVersion: 1,
      acceptedOperationReference: id(16),
      ticketVersion: 2n,
      workItemVersion: 2n,
      evaluatedAt: "2026-08-11T14:10:01.000Z",
      validUntil: "2026-08-11T14:15:00.000Z",
      digests,
    });

    expect(decision).toMatchObject({
      actorReference: id(14),
      ticketReference: id(5),
      workItemReference: id(13),
      acceptedOperationReference: id(16),
      action: "StartKitchenWorkItem",
      outcome: "Allowed",
    });
    expect(decision.decisionDigest).toHaveLength(71);
  });

  it("fails closed for a declined accommodation, changed configuration or expired review", () => {
    const declined = review({ outcome: "CannotSafelyAccommodate" });
    expect(() => acknowledgement(declined)).toThrowError(
      expect.objectContaining({
        code: "KITCHEN_ALLERGEN_ACCOMMODATION_DENIED",
      }),
    );

    const accepted = review();
    expect(() =>
      createKitchenAllergenAcknowledgement({
        acknowledgementReference: id(12),
        review: accepted,
        workItemReference: id(13),
        stage: "BeforeStart",
        operatorActorReference: id(14),
        acknowledgedAt: "2026-08-11T14:10:00.000Z",
        configurationDigest: sha256("configuration-v2"),
        digests,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "KITCHEN_ALLERGEN_CONFIGURATION_CHANGED",
      }),
    );

    expect(() =>
      createKitchenAllergenAcknowledgement({
        acknowledgementReference: id(12),
        review: accepted,
        workItemReference: id(13),
        stage: "BeforeStart",
        operatorActorReference: id(14),
        acknowledgedAt: accepted.validUntil,
        configurationDigest: accepted.configurationDigest,
        digests,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "KITCHEN_ALLERGEN_REVIEW_EXPIRED",
      }),
    );
  });

  it("requires a distinct before-handoff acknowledgement and rejects it as Start evidence", () => {
    const accepted = review();
    const handoff = acknowledgement(accepted, "BeforeHandoff");
    expect(() =>
      createKitchenAllergenStartAdmission({
        review: accepted,
        acknowledgement: handoff,
        decisionReference: id(15),
        decisionVersion: 1,
        acceptedOperationReference: id(16),
        ticketVersion: 2n,
        workItemVersion: 2n,
        evaluatedAt: "2026-08-11T14:10:01.000Z",
        validUntil: "2026-08-11T14:15:00.000Z",
        digests,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "KITCHEN_ALLERGEN_ACKNOWLEDGEMENT_REQUIRED",
      }),
    );
  });

  it("keeps a persistent high-priority non-color KDS cue through both acknowledgement stages", () => {
    const accepted = review();
    const start = acknowledgement(accepted);
    const cue = buildKitchenAllergenKdsCue({
      review: accepted,
      currentConfigurationDigest: accepted.configurationDigest,
      observedAt: "2026-08-11T14:11:00.000Z",
      startAcknowledgement: start,
      handoffAcknowledgement: null,
      digests,
    });
    expect(cue).toMatchObject({
      cueCode: "ALLERGEN_ASSISTANCE",
      priority: "High",
      nonColorIndicator: true,
      startAcknowledgementRequired: false,
      handoffAcknowledgementRequired: true,
      executionBlocked: false,
    });
  });

  it("links a high-risk mismatch to both a Compliance Case and availability Kill Switch", () => {
    expect(
      createKitchenAllergenIncidentLink({
        incidentLinkReference: id(17),
        review: review(),
        incidentType: "AllergenMismatch",
        configurationSnapshotDigest: sha256("configuration-v1"),
        recipeSnapshotDigest: sha256("recipe"),
        handlingSnapshotDigest: sha256("handling"),
        complianceCaseReference: id(18),
        availabilityKillSwitchActionReference: id(19),
        reporterActorReference: id(20),
        reportedAt: "2026-08-11T14:20:00.000Z",
      }),
    ).toMatchObject({
      incidentType: "AllergenMismatch",
      complianceCaseReference: id(18),
      availabilityKillSwitchActionReference: id(19),
    });
  });

  it("rejects free text, medical narrative fields, open objects and unsorted controlled references", () => {
    expect(() => review({ medicalNote: "allergy narrative" })).toThrowError(
      expect.objectContaining({
        code: "KITCHEN_ALLERGEN_INPUT_INVALID",
      }),
    );
    expect(() => review({ allergenReferences: [id(8), id(7)] })).toThrowError(
      expect.objectContaining({
        code: "KITCHEN_ALLERGEN_INPUT_INVALID",
      }),
    );
  });
});
