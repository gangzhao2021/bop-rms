import { expect, it, vi } from "vitest";
import {
  buildPublicationPendingRecord,
  parsePublicationPendingRecord,
} from "./product-publication-pending-record.js";
import {
  createProductPublicationCommandClient,
  productPublicationUserActions,
  type ProductPublicationUserAction,
  type ProductPublicationUserCommand,
} from "./product-publication-command-client.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  csrf = "c".repeat(43),
  hash = "sha256:" + "a".repeat(64);
const scope = { brandReference: id(2), storeReference: id(3) };
function command(action: ProductPublicationUserAction = "Validate"): ProductPublicationUserCommand {
  return {
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 7,
    expectedPublicationVersion: 2,
    action,
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-10-01T12:00:00.000Z",
        localDateTime: "2026-10-01T08:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    },
    scheduleReference: ["SchedulePublish", "ReschedulePublish", "CancelScheduledPublish"].includes(
      action,
    )
      ? id(8)
      : null,
    replacementVersionReference: null,
    successorDraftVersionReference: action === "Publish" ? id(9) : null,
    occurredAt: "2026-10-01T11:00:00.000Z",
    reasonCode: "USER_REQUEST",
  };
}
const selected = { ...scope, tenantReference: id(1), productReference: id(5) };
it.each(productPublicationUserActions)(
  "round trips exact original %s bytes without credentials or renewed fields",
  async (action) => {
    const c = command(action),
      record = await buildPublicationPendingRecord(c, selected),
      restored = await parsePublicationPendingRecord(record, selected);
    expect(restored.command).toEqual(c);
    expect(record.body).toBe(
      JSON.stringify(createProductPublicationCommandClient(vi.fn()).prepare(c, scope).command),
    );
    expect(restored.record).toEqual(record);
    expect(Object.isFrozen(restored.command.effectivePeriod)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(csrf);
    for (const key of [
      "csrf",
      "cookie",
      "sessionCookie",
      "actorReference",
      "validationDecision",
      "approvalEvidenceReference",
      "eligibility",
    ])
      expect(record).not.toHaveProperty(key);
  },
);
it.each(["tenantReference", "brandReference", "storeReference", "productReference"] as const)(
  "refuses restored pending outside exact current %s",
  async (key) => {
    const record = await buildPublicationPendingRecord(command(), selected);
    await expect(
      parsePublicationPendingRecord(record, { ...selected, [key]: id(99) }),
    ).rejects.toMatchObject({ name: "PublicationPendingRecordError" });
  },
);
it.each(["profile", "digest", "body", "operationReference", "csrf", "actorReference", "approved"])(
  "refuses corrupt or private record field %s",
  async (key) => {
    const record = await buildPublicationPendingRecord(command(), selected);
    const value =
      key === "body"
        ? JSON.stringify({ ...command(), occurredAt: "2027-10-01T11:00:00.000Z" })
        : key === "operationReference"
          ? id(99)
          : "Invalid";
    await expect(
      parsePublicationPendingRecord({ ...record, [key]: value }, selected),
    ).rejects.toMatchObject({ name: "PublicationPendingRecordError" });
  },
);
it("refuses noncanonical bytes, mismatch scope Product, arbitrary reason or extra command authority", async () => {
  const c = command(),
    record = await buildPublicationPendingRecord(c, selected);
  await expect(
    parsePublicationPendingRecord({ ...record, body: JSON.stringify(c, null, 2) }, selected),
  ).rejects.toThrow();
  await expect(
    buildPublicationPendingRecord({ ...c, productReference: id(99) }, selected),
  ).rejects.toThrow();
  await expect(
    buildPublicationPendingRecord({ ...c, reasonCode: "PERSON_NAME" }, selected),
  ).rejects.toThrow();
  await expect(buildPublicationPendingRecord({ ...c, approval: true }, selected)).rejects.toThrow();
});
it("never invokes record or command getters", async () => {
  const getter = vi.fn(),
    c = command();
  Object.defineProperty(c, "scopeSet", { enumerable: true, get: getter });
  await expect(buildPublicationPendingRecord(c, selected)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("refuses accessor record without invocation and cyclic expected scope", async () => {
  const getter = vi.fn(),
    original = await buildPublicationPendingRecord(command(), selected);
  const raw = { ...original };
  Object.defineProperty(raw, "body", { enumerable: true, get: getter });
  await expect(parsePublicationPendingRecord(raw, selected)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await expect(
    parsePublicationPendingRecord(original, cyclic as unknown as typeof selected),
  ).rejects.toThrow();
});
