import { expect, it, vi } from "vitest";
import {
  buildProductPublicationWarningAcknowledgementPendingRecord as build,
  parseProductPublicationWarningAcknowledgementPendingRecord as parse,
} from "./product-publication-warning-acknowledgement-pending-record.js";
import { parseAnyPublicationPendingRecord } from "./product-publication-pending-journal-v2.js";
import { parsePublicationPendingRecord } from "./product-publication-pending-record.js";
import { parsePublicationPendingRecordV2 } from "./product-publication-pending-record-v2.js";
import { at, digest, id, scope } from "./product-publication-v2-test-fixtures.js";
const command = () => ({
  profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
  action: "AcknowledgeProductPublicationWarnings",
  operationReference: id(301),
  productReference: scope.productReference,
  versionReference: id(6),
  expectedProductAggregateVersion: 7,
  reportOperationReference: id(302),
  reportDigest: digest("synthetic report"),
  warningBindingDigest: digest("synthetic warnings"),
  warningCodes: ["ChangeImpact"],
  reasonCode: "EXPLICIT_REVIEW",
  occurredAt: at,
});
it("round-trips exact third-profile bytes through shared dispatch while legacy parsers stay closed", async () => {
  const c = command(),
    pending = await build(c, scope),
    restored = await parse(pending, scope);
  expect(restored.command).toEqual(c);
  expect(restored.record).toEqual(pending);
  expect(Object.isFrozen(restored.command.warningCodes)).toBe(true);
  expect((await parseAnyPublicationPendingRecord(pending, scope)).record).toEqual(pending);
  await expect(parsePublicationPendingRecord(pending, scope)).rejects.toThrow();
  await expect(parsePublicationPendingRecordV2(pending, scope)).rejects.toThrow();
  expect(JSON.stringify(pending)).not.toMatch(/csrf|receipt|actorReference|validation/);
});
it.each(["tenantReference", "brandReference", "storeReference", "productReference"] as const)(
  "rejects %s change before original recovery",
  async (key) => {
    await expect(
      parse(await build(command(), scope), { ...scope, [key]: id(99) }),
    ).rejects.toThrow();
  },
);
it.each(["reasonCode", "reportDigest", "warningCodes", "expectedProductAggregateVersion"])(
  "refuses rebound %s without resealing original record",
  async (key) => {
    const c = command(),
      pending = await build(c, scope);
    Object.assign(c, {
      [key]:
        key === "warningCodes"
          ? ["MediaReady"]
          : key === "expectedProductAggregateVersion"
            ? 8
            : key === "reportDigest"
              ? digest("changed")
              : "CHANGED",
    });
    await expect(parse({ ...pending, body: JSON.stringify(c) }, scope)).rejects.toThrow();
  },
);
it("refuses noncanonical body and accessors without reading the accessor", async () => {
  const pending = await build(command(), scope),
    getter = vi.fn();
  await expect(
    parse({ ...pending, body: JSON.stringify(command(), null, 2) }, scope),
  ).rejects.toThrow();
  const corrupt = { ...pending };
  Object.defineProperty(corrupt, "body", { enumerable: true, get: getter });
  await expect(parseAnyPublicationPendingRecord(corrupt, scope)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
