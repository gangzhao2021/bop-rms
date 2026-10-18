import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseBrandReference, parseStoreReference } from "@bop/tenant";
import { mediaPublicationReadFields, parseMediaPublicationReadRequest } from "@bop/media";
import {
  parseProductPublicationCommandV2,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
} from "@rms/catalog";
import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantProductPublicationMediaSource } from "./merchant-product-publication-media.js";
import type { createCurrentProductPublicationMediaSource } from "./current-product-publication-media.js";

const capture = vi.hoisted(() => vi.fn());
vi.mock("./current-product-publication-media.js", () => ({
  createCurrentProductPublicationMediaSource: capture,
}));
const id = (n: number) => `019a2421-0033-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
beforeEach(() => capture.mockReset());
function fixture(acknowledgement = false) {
  const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    replacementIntent = { ...intent, digest: hash(intent) },
    identity = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 1,
      occurredAt: at,
      reasonCode: "SYNTHETIC_MEDIA",
    },
    command = acknowledgement
      ? parseCatalogProductPublicationWarningAcknowledgementCommand({
          ...identity,
          profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
          action: "AcknowledgeProductPublicationWarnings",
          reportOperationReference: id(7),
          reportDigest: hash("report"),
          warningBindingDigest: hash("warnings"),
          warningCodes: ["MediaReady"],
        })
      : parseProductPublicationCommandV2({
          ...identity,
          profile: "CatalogProductPublicationCommandV2",
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          expectedPublicationVersion: 0,
          action: "Validate",
          contentDigest: hash("content"),
          configurationDigest: hash("configuration"),
          replacementIntent,
          replacementIntentDigest: replacementIntent.digest,
          scopeSet: [
            { level: "Store", reference: id(8), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
          ],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
          scheduleReference: null,
          replacementVersionReference: null,
          successorDraftVersionReference: null,
        }),
    state = { now: at },
    transaction = { query: vi.fn(async () => ({ rows: [] })) },
    authorizeMediaAccess = vi.fn(async () => undefined),
    input = {
      transaction,
      command,
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      storeReference: id(8),
      sessionReference: id(9),
      clock: { now: () => state.now },
      originalValidUntil: until,
      authorizeMediaAccess,
      registerBeforeCommit: vi.fn(async () => undefined),
    };
  createMerchantProductPublicationMediaSource(input);
  const options = capture.mock.calls[0]?.[0] as
    Parameters<typeof createCurrentProductPublicationMediaSource>[0] | undefined;
  if (!options) throw new Error("Missing composed Media source");
  const request = parseMediaPublicationReadRequest({
      profile: "MediaPublicationReadRequestV1",
      intentKind: acknowledgement ? "WarningAcknowledgementV1" : "PublicationV2",
      tenantReference: id(1),
      scope: options.scope,
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(4),
      originalIntentDigest: hash(command),
      productReference: id(5),
      versionReference: id(6),
      aggregateSnapshotDigest: hash("aggregate"),
      contentDigest: hash("content"),
      configurationDigest: hash("configuration"),
      replacementIntentDigest: replacementIntent.digest,
      references: [],
      observedAt: at,
      validUntil: until,
    }),
    authority = {
      request,
      action: "media.asset.access" as const,
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ" as const,
      requiredFields: mediaPublicationReadFields,
      command,
      commandPurposeCode: command.purposeCode,
      originalIntentDigest: hash(command),
      requestObservedAt: at,
      requestValidUntil: until,
    };
  return { input, options, authority, transaction, authorizeMediaAccess, state };
}
it.each([false, true])(
  "composes the actual fixed User permission function for Publication/Ack: %s",
  async (ack) => {
    const f = fixture(ack);
    expect(f.options.scope).toEqual({ kind: "Brand", brandReference: id(2), storeReference: null });
    expect(f.options.transaction).toBe(f.transaction);
    expect(f.authorizeMediaAccess).not.toHaveBeenCalled();
    const hold = f.options.authority.holdUntilTransactionCompletes;
    expect(await hold(f.transaction, f.authority)).toEqual({ observedAt: at, validUntil: until });
    f.state.now = "2026-10-03T12:00:02.000Z";
    expect(await hold(f.transaction, f.authority)).toEqual({ observedAt: at, validUntil: until });
    expect(f.authorizeMediaAccess).toHaveBeenCalledTimes(2);
  },
);
it.each([
  "transaction",
  "actor",
  "scope",
  "intent",
  "operation",
  "purpose",
  "fields",
  "command",
  "expiry",
])("rejects mismatched actual authority input: %s", async (mode) => {
  const f = fixture(),
    request = { ...f.authority.request },
    value = { ...f.authority, request };
  if (mode === "actor") request.actorReference = id(99);
  if (mode === "scope")
    request.scope = {
      kind: "Store",
      brandReference: parseBrandReference(id(2)),
      storeReference: parseStoreReference(id(8)),
    };
  if (mode === "intent") request.originalIntentDigest = hash("other");
  if (mode === "operation") request.operationReference = id(99);
  if (mode === "purpose") Object.assign(value, { purposeCode: "MEDIA_IMAGE_PROMOTION" });
  if (mode === "fields") Object.assign(value, { requiredFields: [] });
  if (mode === "command")
    Object.assign(value, { command: { ...value.command, reasonCode: "REPLACED" } });
  if (mode === "expiry") f.state.now = until;
  await expect(
    f.options.authority.holdUntilTransactionCompletes(
      mode === "transaction" ? { query: async () => ({ rows: [] }) } : f.transaction,
      value,
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.authorizeMediaAccess).not.toHaveBeenCalled();
});
it("does not recover from a swallowed current permission failure", async () => {
  const f = fixture();
  f.authorizeMediaAccess.mockRejectedValueOnce(new Error("Controlled current denial"));
  await f.options.authority
    .holdUntilTransactionCompletes(f.transaction, f.authority)
    .catch(() => undefined);
  await expect(
    f.options.authority.holdUntilTransactionCompletes(f.transaction, f.authority),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.authorizeMediaAccess).toHaveBeenCalledTimes(1);
});
