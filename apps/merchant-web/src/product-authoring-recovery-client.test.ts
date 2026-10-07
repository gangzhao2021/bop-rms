import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createProductAuthoringRecoveryClient,
  parseProductAuthoringCursor,
} from "./product-authoring-recovery-client.js";
import { canonicalPublicationValue } from "./product-publication-command-client-v2.js";
const id = (n: number) => "019a2421-0018-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  csrf = "c".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(5),
    action: "Create" as const,
    productReference: null,
  };
const cursor = () =>
  parseProductAuthoringCursor(
    {
      profile: "CatalogProductAuthoringCursorV1",
      scope,
      operationReference: id(8),
      expectedAggregateVersion: null,
    },
    scope,
  );
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
function resolution() {
  const body = {
    profile: "CatalogProductAuthoringResolutionV1",
    outcome: "Committed",
    command: {
      profile: "CatalogProductAuthoringResolutionCommandV1",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(5),
      action: "Create",
      operationReference: id(8),
      productReference: null,
      expectedAggregateVersion: null,
    },
    productReference: id(4),
    versionReference: id(6),
    aggregateVersion: 1,
    originalIntentDigest: "sha256:" + "1".repeat(64),
    recordedAt: at,
  };
  return {
    ...body,
    digest: "sha256:" + createHash("sha256").update(canonicalPublicationValue(body)).digest("hex"),
  };
}
it("loads a bounded authoritative context using CSRF and the exact selected scope", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response({
      profile: "CatalogProductAuthoringContextV1",
      action: "Create",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(5),
      observedAt: at,
      validUntil: "2026-10-04T12:00:05.000Z",
    }),
  );
  await expect(
    createProductAuthoringRecoveryClient(fetcher, () => Date.parse(at)).context(
      "Create",
      scope,
      csrf,
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ tenantReference: id(1), actorReference: id(5) });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/catalog/products/authoring-context");
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe('{"action":"Create"}');
});
it("resolves a matching original outcome without sending or receiving Draft contents", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response({
      profile: "CatalogProductAuthoringResolutionResultV1",
      storeReference: id(3),
      resolution: resolution(),
    }),
  );
  await expect(
    createProductAuthoringRecoveryClient(fetcher).resolve(
      cursor(),
      csrf,
      new AbortController().signal,
    ),
  ).resolves.toEqual({
    outcome: "Committed",
    productReference: id(4),
    versionReference: id(6),
    aggregateVersion: 1,
  });
  expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("draft");
});
it.each(["Actor", "Digest", "Revision"])("rejects rebound original resolution %s", async (mode) => {
  const r = resolution();
  if (mode === "Actor") r.command.actorReference = id(99);
  if (mode === "Digest") r.digest = "sha256:" + "0".repeat(64);
  if (mode === "Revision") r.aggregateVersion = 2;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response({
      profile: "CatalogProductAuthoringResolutionResultV1",
      storeReference: id(3),
      resolution: r,
    }),
  );
  await expect(
    createProductAuthoringRecoveryClient(fetcher).resolve(
      cursor(),
      csrf,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it("a denied or unavailable read never becomes Abandoned", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ error: "request_denied" }, 403));
  await expect(
    createProductAuthoringRecoveryClient(fetcher).resolve(
      cursor(),
      csrf,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "Denied" });
});
it("cursor rejects wrong Actor isolation and any added form contents", () => {
  expect(() =>
    parseProductAuthoringCursor(cursor(), { ...scope, actorReference: id(99) }),
  ).toThrow();
  expect(() =>
    parseProductAuthoringCursor({ ...cursor(), draft: { localizedNames: {} } }, scope),
  ).toThrow();
});
