import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseProductPublicationCommand,
  type ProductPublicationAction,
} from "../contracts/product-publication.js";
import { parseProductPublicationCommandV2 } from "../contracts/product-publication-v2.js";
import { parseCatalogProductPublicationWarningAcknowledgementCommand } from "../contracts/product-publication-warning-acknowledgement.js";
import {
  parseCatalogProductPublicationResolutionCommand as command,
  parseCatalogProductPublicationResolution as parse,
  buildCatalogProductPublicationResolution as build,
  catalogProductPublicationResolutionNamespace as namespace,
  type CatalogProductPublicationResolutionOriginalKind,
} from "../contracts/product-publication-resolution.js";

const id = (n: number) => "019a2421-0015-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-03T10:00:00.000Z",
  later = "2026-11-03T10:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const denied = expect.objectContaining({ code: "CATALOG_INPUT_INVALID" });
function publication(action: ProductPublicationAction = "Validate") {
  return parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: action === "ActivateScheduled" || action === "Supersede" ? "System" : "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action,
    contentDigest: hash("synthetic content"),
    configurationDigest: hash("synthetic configuration"),
    scopeSet: [
      { level: "Store", reference: id(7), channelCodes: ["POS", "WEB"], orderTypeCodes: [] },
    ],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: [
      "SchedulePublish",
      "ReschedulePublish",
      "CancelScheduledPublish",
      "ActivateScheduled",
    ].includes(action)
      ? id(8)
      : null,
    replacementVersionReference: action === "Supersede" ? id(9) : null,
    successorDraftVersionReference:
      action === "Publish" || action === "ActivateScheduled" ? id(10) : null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_ORIGINAL",
  });
}
function original(
  kind: CatalogProductPublicationResolutionOriginalKind,
  action: ProductPublicationAction = "Validate",
) {
  if (kind === "PublicationV1") return publication(action);
  if (kind === "PublicationV2") {
    const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
    return parseProductPublicationCommandV2({
      ...publication(action),
      profile: "CatalogProductPublicationCommandV2",
      replacementIntent: { ...intent, digest: hash(intent) },
      replacementIntentDigest: hash(intent),
    });
  }
  return parseCatalogProductPublicationWarningAcknowledgementCommand({
    profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    action: "AcknowledgeProductPublicationWarnings",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    reportOperationReference: id(11),
    reportDigest: hash("synthetic report"),
    warningBindingDigest: hash("synthetic binding"),
    warningCodes: ["ChangeImpact"],
    reasonCode: "SYNTHETIC_ORIGINAL",
    occurredAt: at,
  });
}
const envelope = (
  kind: CatalogProductPublicationResolutionOriginalKind = "PublicationV2",
  action: ProductPublicationAction = "Validate",
) => ({
  profile: "CatalogProductPublicationResolutionCommandV1",
  originalKind: kind,
  originalCommand: original(kind, action),
});

it.each(["PublicationV1", "PublicationV2", "WarningAcknowledgementV1"] as const)(
  "preserves original owning %s canonical bytes and hashes the full original command",
  (kind) => {
    const input = envelope(kind),
      parsed = command(input);
    expect(canonicalizeRfc8785(parsed.originalCommand)).toBe(
      canonicalizeRfc8785(input.originalCommand),
    );
    for (const outcome of ["Committed", "Abandoned"] as const) {
      const result = build(input, outcome, later),
        c = input.originalCommand;
      expect(result).toEqual(parse(structuredClone(result)));
      expect(result).toMatchObject({
        profile: "CatalogProductPublicationResolutionV1",
        outcome,
        originalKind: kind,
        tenantReference: c.tenantReference,
        brandReference: c.brandReference,
        actorReference: c.actorReference,
        productReference: c.productReference,
        versionReference: c.versionReference,
        operationReference: c.operationReference,
        originalIntentDigest: hash(c),
        recordedAt: later,
      });
      expect(result.originalIntentDigest).not.toBe(hash(input));
      expect(Object.isFrozen(result)).toBe(true);
    }
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.originalCommand)).toBe(true);
    if (kind === "PublicationV1")
      expect(Object.hasOwn(parsed.originalCommand, "profile")).toBe(false);
  },
);
it.each([
  "Validate",
  "SubmitReview",
  "Approve",
  "Reject",
  "Publish",
  "SchedulePublish",
  "ReschedulePublish",
  "CancelScheduledPublish",
] as const)(
  "can recover the original User %s without current lifecycle or expected-root admission",
  (action) => {
    for (const kind of ["PublicationV1", "PublicationV2"] as const) {
      const parsed = command(envelope(kind, action));
      expect(parsed.originalCommand.expectedProductAggregateVersion).toBe(1);
      expect(build(parsed, "Abandoned", later).outcome).toBe("Abandoned");
    }
  },
);
it.each(["ActivateScheduled", "Supersede"] as const)(
  "refuses actual original System %s recovery",
  (action) => {
    expect(parseProductPublicationCommand(publication(action)).actorKind).toBe("System");
    expect(() => command(envelope("PublicationV1", action))).toThrow(denied);
    if (action === "ActivateScheduled")
      expect(() => command(envelope("PublicationV2", action))).toThrow(denied);
  },
);
it("cannot disguise a System action as User or a User action as System", () => {
  const input = envelope("PublicationV1", "ActivateScheduled");
  expect(() =>
    command({ ...input, originalCommand: { ...input.originalCommand, actorKind: "User" } }),
  ).toThrow(denied);
  const user = envelope();
  expect(() =>
    command({ ...user, originalCommand: { ...user.originalCommand, actorKind: "System" } }),
  ).toThrow(denied);
});
it("shares the publication namespace across V1/V2 and keeps Ack in its original namespace", () => {
  expect(namespace("PublicationV1")).toBe("CatalogProductOperation");
  expect(namespace("PublicationV2")).toBe("CatalogProductOperation");
  expect(namespace("WarningAcknowledgementV1")).toBe("CatalogProductWarningAcknowledgement");
});
it.each([
  ["PublicationV1", "PublicationV2"],
  ["PublicationV2", "PublicationV1"],
  ["PublicationV1", "WarningAcknowledgementV1"],
  ["WarningAcknowledgementV1", "PublicationV2"],
] as const)("refuses %s kind around a %s original protocol", (declared, actual) => {
  expect(() => command({ ...envelope(actual), originalKind: declared })).toThrow(denied);
});
it("does not turn an original future timestamp or old root into a fresh execution requirement", () => {
  const input = envelope(),
    changed = { ...input, originalCommand: { ...input.originalCommand, occurredAt: later } };
  const parsed = command(changed),
    result = build(parsed, "Abandoned", at);
  expect(parsed.originalCommand.occurredAt).toBe(later);
  expect(result.recordedAt).toBe(at);
  expect(result.originalIntentDigest).toBe(hash(parsed.originalCommand));
});
it("detaches deeply before hashing while retaining the original V1 canonical normalization", () => {
  const input = structuredClone(envelope("PublicationV1"));
  if (!("scopeSet" in input.originalCommand)) throw Error("Publication fixture");
  const first = input.originalCommand.scopeSet[0];
  if (!first) throw Error("Missing selector");
  Object.assign(first, { channelCodes: ["WEB", "POS"] });
  const parsed = command(input),
    result = build(parsed, "Abandoned", later);
  Object.assign(input.originalCommand, { reasonCode: "MUTATED" });
  Object.assign(first, { channelCodes: ["OTHER"] });
  expect(parsed.originalCommand.reasonCode).toBe("SYNTHETIC_ORIGINAL");
  expect(result.originalIntentDigest).toBe(hash(publication()));
  if (!("scopeSet" in parsed.originalCommand)) throw Error("Publication fixture");
  expect(Object.isFrozen(parsed.originalCommand.scopeSet[0]?.channelCodes)).toBe(true);
});
it.each(["envelope", "original", "nested"] as const)(
  "refuses %s getters without invoking them",
  (location) => {
    const input = structuredClone(envelope()),
      getter = vi.fn(() => "User");
    if (location === "envelope")
      Object.defineProperty(input, "originalKind", { enumerable: true, get: getter });
    else if (location === "original")
      Object.defineProperty(input.originalCommand, "actorKind", { enumerable: true, get: getter });
    else {
      if (!("scopeSet" in input.originalCommand)) throw Error("Publication fixture");
      const first = input.originalCommand.scopeSet[0];
      if (!first) throw Error("Missing selector");
      Object.defineProperty(first, "reference", { enumerable: true, get: getter });
    }
    expect(() => command(input)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  },
);
it.each(["profile", "originalKind", "extra", "undefined-profile", "undefined-original"])(
  "keeps the recovery envelope closed (%s)",
  (mode) => {
    const input = envelope();
    if (mode === "profile") Object.assign(input, { profile: "CatalogProductPublicationCommandV2" });
    if (mode === "originalKind") Object.assign(input, { originalKind: "PublicationV3" });
    if (mode === "extra") Object.assign(input, { reasonCode: "UNREQUESTED" });
    if (mode === "undefined-profile") Object.assign(input, { profile: undefined });
    if (mode === "undefined-original") Object.assign(input, { originalCommand: undefined });
    expect(() => command(input)).toThrow(denied);
  },
);
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "productReference",
  "versionReference",
  "operationReference",
  "originalIntentDigest",
  "recordedAt",
  "outcome",
  "originalKind",
  "digest",
])("rejects a tampered result %s", (field) => {
  const result = build(envelope(), "Abandoned", later);
  const changed =
    field === "outcome"
      ? "Committed"
      : field === "originalKind"
        ? "PublicationV1"
        : field === "recordedAt"
          ? at
          : field.endsWith("Digest") || field === "digest"
            ? hash("other")
            : id(99);
  expect(() => parse({ ...result, [field]: changed })).toThrow(denied);
});
it("rejects result additions, noncanonical dates, unknown outcomes and invalid hashes even if resealed", () => {
  const result = build(envelope(), "Abandoned", later);
  expect(() => parse({ ...result, currentAggregateVersion: 99 })).toThrow(denied);
  for (const patch of [
    { outcome: "NotFound" },
    { recordedAt: "2026-11-03T10:00:00Z" },
    { originalIntentDigest: "a".repeat(64) },
    { actorReference: "unknown" },
  ]) {
    const { digest, ...body } = { ...result, ...patch };
    void digest;
    expect(() => parse({ ...body, digest: hash(body) })).toThrow(denied);
  }
  const getter = vi.fn(() => later),
    accessor = { ...result };
  Object.defineProperty(accessor, "recordedAt", { enumerable: true, get: getter });
  expect(() => parse(accessor)).toThrow(denied);
  expect(getter).not.toHaveBeenCalled();
});
