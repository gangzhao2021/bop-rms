import { expect, it } from "vitest";
import {
  buildCatalogProductAuthoringResolution,
  parseCatalogProductAuthoringResolution,
  parseCatalogProductAuthoringResolutionCommand,
} from "../contracts/product-authoring-resolution.js";
const id = (n: number) => "019a2421-0016-7000-8000-" + n.toString(16).padStart(12, "0");
const command = () => ({
  profile: "CatalogProductAuthoringResolutionCommandV1",
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  action: "Create",
  operationReference: id(4),
  productReference: null,
  expectedAggregateVersion: null,
});
it("captures identity-only uncreated Create and committed native receipt without Draft contents", () => {
  const input = command(),
    parsed = parseCatalogProductAuthoringResolutionCommand(input);
  input.operationReference = id(99);
  const result = buildCatalogProductAuthoringResolution({
    outcome: "Committed",
    command: parsed,
    productReference: id(5),
    versionReference: id(6),
    aggregateVersion: 1,
    originalIntentDigest: "sha256:" + "1".repeat(64),
    recordedAt: "2026-10-04T12:00:00.000Z",
  });
  expect(parseCatalogProductAuthoringResolution(result)).toEqual(result);
  expect(result.command.operationReference).toBe(id(4));
  expect(Object.keys(result)).not.toContain("draft");
  expect(Object.isFrozen(result.command)).toBe(true);
});
it.each(["product", "root", "actor", "action", "extra", "getter"])(
  "rejects malformed original cursor %s",
  (mode) => {
    const input = command();
    if (mode === "product") Object.assign(input, { productReference: id(5) });
    if (mode === "root") Object.assign(input, { expectedAggregateVersion: 1 });
    if (mode === "actor") input.actorReference = "invalid";
    if (mode === "action") input.action = "Publish";
    if (mode === "extra") Object.assign(input, { draft: {} });
    if (mode === "getter")
      Object.defineProperty(input, "operationReference", {
        enumerable: true,
        get() {
          throw new Error("must not execute getter");
        },
      });
    expect(() => parseCatalogProductAuthoringResolutionCommand(input)).toThrow();
  },
);
it("fences absent Draft without inventing a Version or mutating its expected root", () => {
  const parsed = parseCatalogProductAuthoringResolutionCommand({
    ...command(),
    action: "ReplaceDraft",
    productReference: id(5),
    expectedAggregateVersion: 7,
  });
  const result = buildCatalogProductAuthoringResolution({
    outcome: "Abandoned",
    command: parsed,
    productReference: id(5),
    versionReference: null,
    aggregateVersion: null,
    originalIntentDigest: null,
    recordedAt: "2026-10-04T12:00:00.000Z",
  });
  expect(result.outcome).toBe("Abandoned");
  expect(result.command.expectedAggregateVersion).toBe(7);
  expect(() =>
    parseCatalogProductAuthoringResolution({ ...result, aggregateVersion: 8 }),
  ).toThrow();
  expect(() =>
    parseCatalogProductAuthoringResolution({ ...result, digest: "sha256:" + "0".repeat(64) }),
  ).toThrow();
});
