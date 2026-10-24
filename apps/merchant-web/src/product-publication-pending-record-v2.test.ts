import { expect, it, vi } from "vitest";
import {
  buildPublicationPendingRecordV2,
  parsePublicationPendingRecordV2,
} from "./product-publication-pending-record-v2.js";
import {
  buildPublicationPendingRecord,
  parsePublicationPendingRecord,
} from "./product-publication-pending-record.js";
import { parseAnyPublicationPendingRecord } from "./product-publication-pending-journal-v2.js";
import { command, exact, id, scope } from "./product-publication-v2-test-fixtures.js";
it.each(["None", "Exact"])(
  "preserves original %s full target and bytes across durable recovery",
  async (mode) => {
    const c = command();
    if (mode === "Exact") {
      const target = exact();
      Object.assign(c, { replacementIntent: target, replacementIntentDigest: target.digest });
    }
    const record = await buildPublicationPendingRecordV2(c, scope),
      restored = await parsePublicationPendingRecordV2(record, scope);
    expect(restored.command).toEqual(c);
    expect(restored.record).toEqual(record);
    expect(Object.isFrozen(restored.command.replacementIntent)).toBe(true);
    expect((await parseAnyPublicationPendingRecord(record, scope)).record).toEqual(record);
    await expect(parsePublicationPendingRecord(record, scope)).rejects.toThrow();
    expect(JSON.stringify(record)).not.toContain("csrf");
  },
);
it("recognizes existing V1 original records without upgrading their body", async () => {
  const { profile, replacementIntent, replacementIntentDigest, ...legacy } = command();
  void profile;
  void replacementIntent;
  void replacementIntentDigest;
  const original = await buildPublicationPendingRecord(legacy, scope),
    restored = await parseAnyPublicationPendingRecord(original, scope);
  expect(restored.record).toEqual(original);
  expect(restored.command).not.toHaveProperty("profile");
  await expect(parsePublicationPendingRecordV2(original, scope)).rejects.toThrow();
});
it.each(["tenantReference", "brandReference", "storeReference", "productReference"] as const)(
  "rejects changed recovery %s",
  async (key) => {
    const original = await buildPublicationPendingRecordV2(command(), scope);
    await expect(
      parsePublicationPendingRecordV2(original, { ...scope, [key]: id(99) }),
    ).rejects.toThrow();
  },
);
it("rejects retargeted body, noncanonical body and accessors before execution", async () => {
  const original = await buildPublicationPendingRecordV2(command(), scope),
    retarget = command();
  const target = exact();
  Object.assign(retarget, { replacementIntent: target, replacementIntentDigest: target.digest });
  await expect(
    parsePublicationPendingRecordV2({ ...original, body: JSON.stringify(retarget) }, scope),
  ).rejects.toThrow();
  await expect(
    parsePublicationPendingRecordV2(
      { ...original, body: JSON.stringify(command(), null, 2) },
      scope,
    ),
  ).rejects.toThrow();
  const getter = vi.fn(),
    raw = { ...original };
  Object.defineProperty(raw, "body", { enumerable: true, get: getter });
  await expect(parseAnyPublicationPendingRecord(raw, scope)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
