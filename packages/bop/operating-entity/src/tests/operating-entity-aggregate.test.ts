import { describe, expect, it } from "vitest";
import { parseOrganizationVersion } from "@bop/tenant";
import {
  OperatingEntityContractError,
  createBrandOperatingEntityAssignment,
  createOperatingEntity,
  createStoreOperatingEntityAssignment,
  resolveStoreOperatingEntity,
  transitionOperatingEntity,
} from "../index.js";

const BRAND = "018f3f7a-8b1c-7a11-8d01-000000000001";
const OTHER_BRAND = "018f3f7a-8b1c-7a11-8d01-000000000009";
const STORE = "018f3f7a-8b1c-7a11-8d01-000000000002";
const ENTITY = "018f3f7a-8b1c-7a11-8d01-000000000003";
const EVIDENCE = "018f3f7a-8b1c-7a11-8d01-000000000004";
const ASSIGNMENT = "018f3f7a-8b1c-7a11-8d01-000000000005";
const NOW = "2026-07-28T12:00:00.000Z";
const LATER = "2026-07-28T12:01:00.000Z";
const entityInput = () => ({
  operatingEntityReference: ENTITY,
  kind: "LegalEntity",
  legalName: "Synthetic Ontario Incorporated",
  tradeName: null,
  jurisdictionCode: "CA-ON",
  registrationReference: null,
  taxRegistrationReference: null,
  billingIdentityReference: null,
  settlementReference: null,
  evidenceReference: null,
  lifecycle: "Draft",
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});
const assignmentInput = () => ({
  assignmentReference: ASSIGNMENT,
  brandReference: BRAND,
  operatingEntityReference: ENTITY,
  businessFunction: "SalesReceiptIssuer",
  lifecycle: "Active",
  effectiveFrom: NOW,
  effectiveUntil: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  storeReference: STORE,
});

describe("Operating Entity aggregate and assignment contract", () => {
  it("keeps LegalEntity and CA-ON closed and requires evidence for Active", () => {
    expect(() => createOperatingEntity({ ...entityInput(), kind: "Person" })).toThrowError(
      "operating entity shape is invalid",
    );
    expect(() => createOperatingEntity({ ...entityInput(), lifecycle: "Active" })).toThrowError(
      "operating entity evidence is required",
    );
    expect(
      createOperatingEntity({
        ...entityInput(),
        evidenceReference: EVIDENCE,
        lifecycle: "Active",
      }).lifecycle,
    ).toBe("Active");
  });

  it("enforces evidence, expected version and transition graph", () => {
    const pending = transitionOperatingEntity(
      createOperatingEntity(entityInput()),
      parseOrganizationVersion(1),
      "PendingExternalEvidence",
      LATER,
    );
    expect(() =>
      transitionOperatingEntity(pending, parseOrganizationVersion(2), "Active", LATER),
    ).toThrowError("operating entity evidence is required");
    expect(() =>
      transitionOperatingEntity(pending, parseOrganizationVersion(1), "Archived", LATER),
    ).toThrowError("operating entity version conflict");
  });

  it("rejects unknown fields, prototype and invalid effective periods", () => {
    expect(() => createOperatingEntity({ ...entityInput(), unknown: true })).toThrowError(
      "operating entity shape is invalid",
    );
    expect(() => createOperatingEntity(Object.create(entityInput()))).toThrow(
      OperatingEntityContractError,
    );
    expect(() =>
      createStoreOperatingEntityAssignment({
        ...assignmentInput(),
        effectiveUntil: NOW,
      }),
    ).toThrowError("assignment shape is invalid");
  });

  it("resolves only an exact active Store assignment with a half-open period", () => {
    const assignment = createStoreOperatingEntityAssignment({
      ...assignmentInput(),
      effectiveUntil: LATER,
    });
    expect(resolveStoreOperatingEntity([assignment], BRAND, STORE, "SalesReceiptIssuer", NOW)).toBe(
      assignment,
    );
    expect(() =>
      resolveStoreOperatingEntity([assignment], BRAND, STORE, "SalesReceiptIssuer", LATER),
    ).toThrowError("assignment was not found");
  });

  it("fails closed for wrong Brand, missing, suspended and ambiguous assignments", () => {
    const active = createStoreOperatingEntityAssignment(assignmentInput());
    const suspended = createStoreOperatingEntityAssignment({
      ...assignmentInput(),
      assignmentReference: "018f3f7a-8b1c-7a11-8d01-000000000006",
      lifecycle: "Suspended",
    });
    for (const [assignments, brand] of [
      [[], BRAND],
      [[active], OTHER_BRAND],
      [[suspended], BRAND],
    ] as const)
      expect(() =>
        resolveStoreOperatingEntity(assignments, brand, STORE, "SalesReceiptIssuer", NOW),
      ).toThrowError("assignment was not found");
    const duplicate = createStoreOperatingEntityAssignment({
      ...assignmentInput(),
      assignmentReference: "018f3f7a-8b1c-7a11-8d01-000000000007",
    });
    expect(() =>
      resolveStoreOperatingEntity([active, duplicate], BRAND, STORE, "SalesReceiptIssuer", NOW),
    ).toThrowError("assignment is ambiguous");
  });

  it("does not treat a Brand assignment as a Store fallback", () => {
    expect(
      createBrandOperatingEntityAssignment({
        assignmentReference: ASSIGNMENT,
        brandReference: BRAND,
        operatingEntityReference: ENTITY,
        businessFunction: "SalesReceiptIssuer",
        lifecycle: "Active",
        effectiveFrom: NOW,
        effectiveUntil: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }).brandReference,
    ).toBe(BRAND);
    expect(() =>
      resolveStoreOperatingEntity([], BRAND, STORE, "SalesReceiptIssuer", NOW),
    ).toThrowError("assignment was not found");
  });
});
