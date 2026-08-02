import { describe, expect, it } from "vitest";

import {
  CatalogError,
  supersedePublishedMenu,
  transitionMenuPublication,
  validateMenuEffectivePeriod,
} from "../index.js";

const id = (n: number) => `018f7200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const at = "2026-08-01T16:00:00.000Z";
const scope = { kind: "Brand", brandReference: id(1), storeReference: null } as const;
function lifecycle(state = "Draft", version = 1) {
  return {
    lifecycleId: id(2),
    familyReference: id(3),
    configurationType: "MENU",
    purposeCode: "CUSTOMER_ORDERING",
    snapshotReference: id(4),
    snapshotDigest: digest,
    scope,
    version,
    state,
    validationEvidenceReference: state === "Draft" ? null : id(5),
    approvalEvidenceReference: ["Approved", "Published", "Archived"].includes(state) ? id(6) : null,
    createdAt: at,
    changedAt: at,
  } as never;
}
function validation(overrides: Record<string, unknown> = {}) {
  return {
    evidenceReference: id(5),
    snapshotReference: id(4),
    snapshotDigest: digest,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil: "2026-08-02T16:00:00.000Z",
    checkCodes: ["REFERENCES_RESOLVED"],
    ...overrides,
  } as never;
}
function approval(overrides: Record<string, unknown> = {}) {
  return {
    evidenceReference: id(6),
    reviewLifecycleId: id(2),
    reviewVersion: 2,
    snapshotReference: id(4),
    snapshotDigest: digest,
    scope,
    decision: "Accepted",
    approvedActorReference: id(7),
    approvedAt: "2026-08-01T16:05:00.000Z",
    validUntil: "2026-08-02T16:00:00.000Z",
    ...overrides,
  } as never;
}

describe("Menu publication lifecycle", () => {
  it("requires fresh exact-snapshot validation before review", () => {
    expect(
      transitionMenuPublication({
        operation: "SubmitReview",
        current: lifecycle(),
        validation: validation(),
        approval: null,
        at,
      }),
    ).toMatchObject({ state: "InReview", version: 2, validationEvidenceReference: id(5) });
    expect(() =>
      transitionMenuPublication({
        operation: "SubmitReview",
        current: lifecycle(),
        validation: validation({ snapshotDigest: `sha256:${"b".repeat(64)}` }),
        approval: null,
        at,
      }),
    ).toThrowError(CatalogError);
  });

  it("binds approval to the exact reviewed lifecycle revision", () => {
    expect(
      transitionMenuPublication({
        operation: "Approve",
        current: lifecycle("InReview", 2),
        validation: null,
        approval: approval(),
        at: "2026-08-01T16:06:00.000Z",
      }),
    ).toMatchObject({ state: "Approved", version: 3, approvalEvidenceReference: id(6) });
    expect(() =>
      transitionMenuPublication({
        operation: "Approve",
        current: lifecycle("InReview", 2),
        validation: null,
        approval: approval({ reviewVersion: 1 }),
        at: "2026-08-01T16:06:00.000Z",
      }),
    ).toThrowError(CatalogError);
  });

  it("publishes then archives without changing snapshot identity", () => {
    const published = transitionMenuPublication({
      operation: "Publish",
      current: lifecycle("Approved", 3),
      validation: null,
      approval: null,
      at: "2026-08-01T17:00:00.000Z",
    });
    expect(published).toMatchObject({
      state: "Published",
      version: 4,
      snapshotReference: id(4),
      snapshotDigest: digest,
    });
    expect(
      transitionMenuPublication({
        operation: "Archive",
        current: published,
        validation: null,
        approval: null,
        at: "2026-08-01T18:00:00.000Z",
      }),
    ).toMatchObject({ state: "Archived", version: 5, snapshotReference: id(4) });
  });

  it("supersedes an earlier published revision without mutating its snapshot", () => {
    expect(
      supersedePublishedMenu(lifecycle("Published", 4), "2026-08-02T00:00:00.000Z"),
    ).toMatchObject({
      state: "Superseded",
      version: 5,
      snapshotReference: id(4),
      snapshotDigest: digest,
    });
    expect(() => supersedePublishedMenu(lifecycle("Approved", 3), at)).toThrowError(CatalogError);
  });

  it("rejects illegal lifecycle jumps and invalid effective periods", () => {
    expect(() =>
      transitionMenuPublication({
        operation: "Publish",
        current: lifecycle(),
        validation: null,
        approval: null,
        at,
      }),
    ).toThrowError(CatalogError);
    expect(() => validateMenuEffectivePeriod(null)).toThrowError(CatalogError);
    expect(
      validateMenuEffectivePeriod({
        timeZone: "UTC",
        effectiveFrom: {
          instant: "2026-08-02T00:00:00.000Z",
          localDateTime: "2026-08-02T00:00:00.000",
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      } as never),
    ).toMatchObject({ timeZone: "UTC" });
  });
});
