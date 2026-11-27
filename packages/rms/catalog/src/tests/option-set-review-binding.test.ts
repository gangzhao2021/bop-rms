import { expect, it, vi } from "vitest";
import {
  createCatalogOptionSetContentReviewBinding as bind,
  optionContentReviewValidationCodes,
} from "../contracts/option-set-review-binding.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (n: string) => "sha256:" + n.repeat(64);
const input = () => ({
  tenantReference: id(1),
  brandReference: id(2),
  optionSetReference: id(100),
  versionReference: id(101),
  expectedAggregateVersion: 1,
  sourceDigest: digest("a"),
  contentDigest: digest("b"),
  configurationDigest: digest("c"),
  graphDigest: digest("d"),
  policyReference: id(5),
  policyVersion: 1,
  policyContentDigest: digest("e"),
  currentPolicyPublicationReference: id(6),
  originalIntentDigest: digest("f"),
  activationAt: "2026-09-30T12:00:00.000Z",
});
it("creates a stable detached review intent without implying qualification", () => {
  const a = input(),
    first = bind(a);
  a.sourceDigest = digest("b");
  expect(first.digest).toBe(bind(input()).digest);
  expect(first.sourceDigest).not.toBe(a.sourceDigest);
  expect(Object.isFrozen(first)).toBe(true);
  expect(first).not.toHaveProperty("eligibility");
  expect(first).not.toHaveProperty("observedAt");
  expect(first).not.toHaveProperty("validUntil");
  expect(optionContentReviewValidationCodes).toEqual([
    "CURRENT_REFERENCES",
    "PUBLISHING_POLICY",
    "RULE_SATISFIABILITY",
    "SCOPE_TOPOLOGY",
  ]);
});
it.each(Object.keys(input()))("changes review identity when %s changes", (key) => {
  const a: Record<string, unknown> = input(),
    previous = bind(a).digest;
  a[key] =
    key === "activationAt"
      ? "2026-09-30T12:00:01.000Z"
      : typeof a[key] === "number"
        ? 2
        : key.endsWith("Digest")
          ? digest("0")
          : id(999);
  expect(bind(a).digest).not.toBe(previous);
});
it.each(["observedAt", "validUntil", "Ready", "approval", "graph"])(
  "refuses unbound field %s",
  (key) => {
    expect(() => bind({ ...input(), [key]: true })).toThrow();
  },
);
it("refuses missing selectors and accessors without evaluating them", () => {
  const a: Record<string, unknown> = input();
  delete a.currentPolicyPublicationReference;
  expect(() => bind(a)).toThrow();
  const b = input(),
    getter = vi.fn(() => id(1));
  Object.defineProperty(b, "tenantReference", { get: getter, enumerable: true });
  expect(() => bind(b)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([0, -1, 1.1, 2147483648, NaN])("refuses revision %s", (n) => {
  expect(() => bind({ ...input(), expectedAggregateVersion: n })).toThrow();
  expect(() => bind({ ...input(), policyVersion: n })).toThrow();
});
it("allows max int32 as read identity", () => {
  expect(bind({ ...input(), expectedAggregateVersion: 2147483647 }).expectedAggregateVersion).toBe(
    2147483647,
  );
});
