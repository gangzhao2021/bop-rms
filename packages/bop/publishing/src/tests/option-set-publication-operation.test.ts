import { expect, it, vi } from "vitest";
import {
  parsePublishingOptionSetPublicationOperation as parse,
  publishingOptionSetPublicationOperationDigest as digest,
} from "../contracts/option-set-publication-operation.js";
const id = (n: number) => "01902421-7000-7000-8000-" + n.toString(16).padStart(12, "0"),
  hash = "sha256:" + "a".repeat(64);
function input() {
  return {
    profile: "PublishingOptionSetPublicationOperationV1",
    tenantReference: id(1),
    brandReference: id(2),
    selectedStoreReference: id(3),
    actorReference: id(4),
    reasonCode: "AUTHORIZED_OPERATION",
    action: "SubmitReview",
    operationReference: id(5),
    optionSetReference: id(6),
    versionReference: id(7),
    expectedAggregateVersion: 1,
    sourceDigest: hash,
    contentDigest: hash,
    configurationDigest: hash,
    expectedReview: null,
    expectedLifecycle: null,
  };
}
it("retains canonical original intent without generated IDs or time", () => {
  const original = input(),
    command = parse(original);
  expect(Object.isFrozen(command)).toBe(true);
  expect(digest(command)).toBe(digest(parse({ ...original })));
  expect(digest(parse({ ...original, sourceDigest: "sha256:" + "b".repeat(64) }))).not.toBe(
    digest(command),
  );
});
it.each([
  { occurredAt: "2026-10-05T12:00:00.000Z" },
  { lifecycleReference: id(30) },
  { action: "CreateDraft" },
  { expectedAggregateVersion: 0 },
  { versionReference: "unknown" },
  { action: "Approve" },
  { action: "Publish" },
])("rejects a retargeted or incomplete original command %#", (patch) => {
  expect(() => parse({ ...input(), ...patch })).toThrow();
});
it("binds original recorded Review and exact owner lifecycle for independent approval", () => {
  const command = parse({
    ...input(),
    action: "Approve",
    expectedReview: {
      reviewOperationReference: id(80),
      publishingReviewOperationReference: id(8),
      recordDigest: hash,
      bindingDigest: hash,
    },
    expectedLifecycle: {
      lifecycleReference: id(9),
      version: 2,
      state: "InReview",
      latestMutationOperationReference: id(8),
    },
  });
  expect(command.expectedReview?.reviewOperationReference).toBe(id(80));
  expect(() =>
    parse({ ...command, expectedLifecycle: { ...command.expectedLifecycle, state: "Draft" } }),
  ).toThrow();
});
it("never invokes caller accessor while closing the command", () => {
  const raw = input(),
    get = vi.fn(() => id(4));
  Object.defineProperty(raw, "actorReference", { get, enumerable: true });
  expect(() => parse(raw)).toThrow();
  expect(get).not.toHaveBeenCalled();
});

it("requires the independent Publishing Review reference and refuses an inferred Catalog alias", () => {
  const base = {
    ...input(),
    action: "Approve",
    expectedReview: {
      reviewOperationReference: id(80),
      publishingReviewOperationReference: id(8),
      recordDigest: hash,
      bindingDigest: hash,
    },
    expectedLifecycle: {
      lifecycleReference: id(9),
      version: 2,
      state: "InReview",
      latestMutationOperationReference: id(8),
    },
  };
  expect(parse(base).expectedReview?.publishingReviewOperationReference).toBe(id(8));
  const missing = { ...base.expectedReview };
  Reflect.deleteProperty(missing, "publishingReviewOperationReference");
  expect(() => parse({ ...base, expectedReview: missing })).toThrow();
  expect(() =>
    parse({
      ...base,
      expectedReview: { ...base.expectedReview, publishingReviewOperationReference: id(80) },
    }),
  ).toThrow();
});
