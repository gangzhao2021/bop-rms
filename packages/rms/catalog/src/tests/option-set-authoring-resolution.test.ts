import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseCatalogReference, parseCatalogInstant } from "../contracts/product.js";
import {
  parseCatalogOptionSetAuthoringResolutionCommand,
  createCatalogOptionSetAuthoringIdentity,
  parseCatalogOptionSetAuthoringIdentity,
  createCatalogOptionSetAuthoringResolution,
  parseCatalogOptionSetAuthoringResolution,
} from "../contracts/option-set-authoring-resolution.js";
const id = (n: number) =>
    parseCatalogReference("01902421-7007-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-10-05T12:00:00.000Z"),
  hash = "sha256:" + "a".repeat(64);
function command(action: "Create" | "Edit" = "Create") {
  return parseCatalogOptionSetAuthoringResolutionCommand({
    profile: "CatalogOptionSetAuthoringResolutionCommandV1",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    action,
    reasonCode: "SYNTHETIC",
    operationReference: id(4),
    optionSetReference: action === "Create" ? null : id(5),
    expectedAggregateVersion: action === "Create" ? null : 7,
  });
}
function identity(action: "Create" | "Edit" = "Create") {
  return createCatalogOptionSetAuthoringIdentity({
    command: command(action),
    sourceOperationReference: id(4),
    optionSetReference: id(5),
    versionReference: id(6),
    aggregateVersion: action === "Create" ? 1 : 8,
    originalOccurredAt: at,
    auditReference: id(7),
    originalIntentDigest: hash,
    sourceDigest: hash,
    contentDigest: hash,
    configurationDigest: hash,
  });
}
it.each(["Create", "Edit"] as const)(
  "roundtrips original %s metadata independently from today's root",
  (action) => {
    const original = identity(action),
      resolution = createCatalogOptionSetAuthoringResolution({
        outcome: "Committed",
        command: command(action),
        identity: original,
        recordedAt: at,
      });
    expect(parseCatalogOptionSetAuthoringIdentity(JSON.parse(JSON.stringify(original)))).toEqual(
      original,
    );
    expect(parseCatalogOptionSetAuthoringResolution(resolution)).toEqual(resolution);
    expect(Object.isFrozen(original.command)).toBe(true);
  },
);
it.each(["Create", "Edit"] as const)(
  "keeps %s true absence without fabricated IDs/time/source digest",
  (action) => {
    const result = createCatalogOptionSetAuthoringResolution({
      outcome: "Abandoned",
      command: command(action),
      identity: null,
      recordedAt: at,
    });
    expect(result.identity).toBeNull();
    expect(parseCatalogOptionSetAuthoringResolution(result)).toEqual(result);
  },
);
it.each(["actorReference", "reasonCode", "expectedAggregateVersion"])(
  "rejects changed committed command %s",
  (field) => {
    const original = identity("Edit"),
      changed = {
        ...original.command,
        [field]: field === "actorReference" ? id(9) : field === "reasonCode" ? "CHANGED" : 6,
      };
    expect(() =>
      createCatalogOptionSetAuthoringResolution({
        outcome: "Committed",
        command: changed,
        identity: original,
        recordedAt: at,
      }),
    ).toThrow();
  },
);
it.each([
  { optionSetReference: id(5) },
  { expectedAggregateVersion: 1 },
  { expectedAggregateVersion: 0 },
  { reasonCode: " lowercase" },
  { extra: true },
])("rejects malformed/unknown initial identity %j", (change) => {
  expect(() =>
    parseCatalogOptionSetAuthoringResolutionCommand({ ...command(), ...change }),
  ).toThrow();
});
it.each([0, 2147483647, 1.5, null])(
  "rejects Edit exhausted or malformed expected root %s",
  (expected) => {
    expect(() =>
      parseCatalogOptionSetAuthoringResolutionCommand({
        ...command("Edit"),
        expectedAggregateVersion: expected,
      }),
    ).toThrow();
  },
);
it("refuses originalsource/time/digest tamper and getters", () => {
  const original = identity();
  for (const change of [
    { sourceOperationReference: id(9) },
    { aggregateVersion: 2 },
    { digest: "sha256:" + "b".repeat(64) },
    { originalOccurredAt: "not UTC" },
    { extra: true },
  ])
    expect(() => parseCatalogOptionSetAuthoringIdentity({ ...original, ...change })).toThrow();
  const getter = Object.defineProperty({ ...command() }, "reasonCode", {
    enumerable: true,
    get() {
      throw new Error("getter executed");
    },
  });
  expect(() => parseCatalogOptionSetAuthoringResolutionCommand(getter)).toThrow(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
  const changed = { ...original, originalOccurredAt: "2026-10-05T12:01:00.000Z" },
    { digest, ...body } = changed;
  void digest;
  expect(
    parseCatalogOptionSetAuthoringIdentity({
      ...body,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    }).originalOccurredAt,
  ).toBe(body.originalOccurredAt);
  expect(() =>
    createCatalogOptionSetAuthoringResolution({
      outcome: "Committed",
      command: original.command,
      identity: original,
      recordedAt: parseCatalogInstant(body.originalOccurredAt),
    }),
  ).toThrow();
});
