import { expect, it, vi } from "vitest";
import { createPostgresGuestEntryAdmissionStore } from "../infrastructure/persistence/guest-entry-admission-store.js";
const id = (n: number) => "0190ed20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-01-15T12:00:00.000Z";
function setup() {
  const evidence = {
    decision: "Allowed",
    evidenceReference: id(5),
    entryRequestReference: id(3),
    brandReference: id(1),
    storeReference: id(2),
    publicStoreReference: id(6),
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA",
    qrReference: id(7),
    qrRevocationVersion: 1,
    evaluatedAt: at,
    validUntil: "2026-01-15T12:01:00.000Z",
  };
  const input = { evidence, operationReference: id(4), auditReference: id(8), requestedAt: at };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("INSERT") ? [{ entry_request_id: id(3) }] : [],
  }));
  const authorize = vi.fn(async () => true);
  const appendAudit = vi.fn(
    async (
      ...args: Parameters<
        Parameters<typeof createPostgresGuestEntryAdmissionStore>[0]["appendAudit"]
      >
    ) => {
      void args;
    },
  );
  const tx = { query };
  const store = createPostgresGuestEntryAdmissionStore({
    brandReference: id(1),
    storeReference: id(2),
    authorize,
    appendAudit,
  });
  return { input, query, authorize, appendAudit, tx, store };
}
it("does not write out-of-scope, expired or unauthorized evidence", async () => {
  const x = setup();
  expect(
    await x.store.consume(x.tx, {
      ...x.input,
      evidence: { ...x.input.evidence, storeReference: id(99) },
    }),
  ).toBeNull();
  expect(
    await x.store.consume(x.tx, { ...x.input, requestedAt: x.input.evidence.validUntil }),
  ).toBeNull();
  expect(await x.store.consume(x.tx, { ...x.input, operationReference: id(3) })).toBeNull();
  expect(x.authorize).not.toHaveBeenCalled();
  x.authorize.mockResolvedValueOnce(false);
  expect(await x.store.consume(x.tx, x.input)).toBeNull();
  expect(x.query).not.toHaveBeenCalled();
});
it("appends Audit in the retained transaction and fails on late withdrawal or Audit failure", async () => {
  const x = setup();
  x.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(x.store.consume(x.tx, x.input)).rejects.toThrow("GUEST_ENTRY_ADMISSION_UNAVAILABLE");
  expect(x.appendAudit.mock.calls[0]?.[0]).toBe(x.tx);
  const broken = setup();
  broken.appendAudit.mockRejectedValueOnce(new Error("synthetic audit failure"));
  await expect(broken.store.consume(broken.tx, broken.input)).rejects.toThrow(
    "synthetic audit failure",
  );
});
it("rejects consumed keys without another Audit and accepts only a confirmed inserted row", async () => {
  const x = setup();
  x.query.mockResolvedValue({ rows: [] });
  expect(await x.store.consume(x.tx, x.input)).toBeNull();
  expect(x.appendAudit).not.toHaveBeenCalled();
  const inserted = setup();
  expect(await inserted.store.consume(inserted.tx, inserted.input)).toEqual(
    inserted.input.evidence,
  );
  expect(inserted.authorize).toHaveBeenCalledTimes(2);
  expect(inserted.appendAudit).toHaveBeenCalledOnce();
});
