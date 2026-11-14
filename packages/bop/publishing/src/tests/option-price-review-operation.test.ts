import { expect, it, vi } from "vitest";
import {
  parsePublishingOptionPriceReviewOperation as parse,
  publishingOptionPriceReviewOperationDigest as digest,
} from "../contracts/option-price-review-operation.js";
const id = (n: number) => "01902421-7000-7000-8000-" + n.toString(16).padStart(12, "0");
const input = () => ({
  profile: "PublishingOptionPriceReviewOperationV1",
  tenantReference: id(1),
  brandReference: id(2),
  selectedStoreReference: id(3),
  actorReference: id(4),
  reasonCode: "AUTHORIZED_OPERATION",
  action: "SubmitReview",
  operationReference: id(5),
  ruleReference: id(6),
  draftVersionReference: id(7),
  draftSnapshotDigest: "sha256:" + "a".repeat(64),
  expectedAggregateVersion: 1,
  validationValidUntil: "2026-09-12T12:00:00.000Z",
  approvalValidUntil: null,
  expectedLifecycle: null,
});
it("closed stable original excludes generated clocks/evidence and detaches all identities", () => {
  const value = input(),
    a = parse(value);
  expect(Object.isFrozen(a)).toBe(true);
  expect(digest(a)).toBe(digest(parse({ ...value })));
  expect(digest(parse({ ...value, validationValidUntil: "2026-09-13T12:00:00.000Z" }))).not.toBe(
    digest(a),
  );
});
it("Approve binds original validation business expiry and actual InReview head", () => {
  const a = parse({
    ...input(),
    action: "Approve",
    approvalValidUntil: "2026-09-12T11:00:00.000Z",
    expectedLifecycle: {
      lifecycleReference: id(9),
      version: 2,
      state: "InReview",
      latestMutationOperationReference: id(8),
    },
  });
  expect(Object.isFrozen(a.expectedLifecycle)).toBe(true);
  expect(a.approvalValidUntil).toBe("2026-09-12T11:00:00.000Z");
});
it.each([
  { occurredAt: "2026-09-11T12:00:00.000Z" },
  { evidenceReference: id(9) },
  { action: "Publish" },
  { reasonCode: "PUBLISHING_REVIEW_SUBMITTED" },
  { expectedAggregateVersion: 0 },
  { validationValidUntil: "2026-09-12" },
  { draftVersionReference: "unknown" },
  { approvalValidUntil: "2026-09-12T11:00:00.000Z" },
  { action: "Approve" },
])("rejects extra/server-only or inconsistent intent %#", (patch) => {
  expect(() => parse({ ...input(), ...patch })).toThrow();
});
it("approval cannot outlive original validation or bind a Draft state", () => {
  for (const state of ["Draft", "Approved"])
    expect(() =>
      parse({
        ...input(),
        action: "Approve",
        approvalValidUntil: "2026-09-12T11:00:00.000Z",
        expectedLifecycle: {
          lifecycleReference: id(9),
          version: 2,
          state,
          latestMutationOperationReference: id(8),
        },
      }),
    ).toThrow();
  expect(() =>
    parse({
      ...input(),
      action: "Approve",
      approvalValidUntil: "2026-09-13T11:00:00.000Z",
      expectedLifecycle: {
        lifecycleReference: id(9),
        version: 2,
        state: "InReview",
        latestMutationOperationReference: id(8),
      },
    }),
  ).toThrow();
});
it("accessors are never executed as public request facts", () => {
  const getter = vi.fn(() => id(2)),
    value = input();
  Object.defineProperty(value, "brandReference", { enumerable: true, get: getter });
  expect(() => parse(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
