import { describe, expect, it, vi } from "vitest";
import {
  appendAuditRecordInTransaction,
  AuditPersistenceError,
  validateAuditRecord,
} from "../index.js";

const id = (digit: string) => `018f1f48-7b5d-7cc${digit}-8a1b-123456789abc`;
const record = () => ({
  auditId: id("1"),
  brandId: id("2"),
  storeId: id("3"),
  actor: { type: "User" as const, reference: id("4") },
  actionCode: "CATALOG_PRODUCT_UPDATED",
  targetType: "CatalogProduct",
  targetId: id("5"),
  beforeSummary: { status: "Draft" },
  afterSummary: { status: "Active" },
  reasonCode: "AUTHORIZED_UPDATE",
  correlationId: id("6"),
  occurredAt: "2026-07-27T12:00:00.000Z",
  sourceChannel: "API",
  dataClassification: "Internal" as const,
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
});

describe("Audit append contract", () => {
  it("validates, allocates and advances one exact chain partition", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            next_sequence: "1",
            previous_hash: null,
            recorded_at: "2026-07-27T12:01:02.003Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ next_sequence: "2" }] });
    const appended = await appendAuditRecordInTransaction({ query }, record());
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO platform_audit.audit_chain_head");
    expect(query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(query.mock.calls[2]?.[0]).toContain("INSERT INTO platform_audit.audit_record");
    expect(query.mock.calls[2]?.[1]).toHaveLength(24);
    expect(query.mock.calls[3]?.[0]).toContain("UPDATE platform_audit.audit_chain_head");
    expect(appended).toMatchObject({
      version: "AUDIT_CHAIN_V1",
      sequence: 1,
      previousHash: null,
      recordedAt: "2026-07-27T12:01:02.003Z",
    });
    expect(appended.recordHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ["uuid", { auditId: "not-an-id" }],
    ["actor", { actor: { type: "System", reference: id("4") } }],
    ["code", { actionCode: "unsafe.code" }],
    ["classification", { dataClassification: "Unknown" }],
    ["secret key", { afterSummary: { accessToken: "redacted" } }],
    ["request body", { afterSummary: { requestBody: { safe: "value" } } }],
    ["secret value", { afterSummary: { safe: "Bearer abc.def.ghi" } }],
    ["unknown field", { note: "not allowed" }],
    ["future", { occurredAt: "2099-01-01T00:00:00.000Z" }],
  ])("rejects %s", (_name, override) => {
    expect(() => validateAuditRecord({ ...record(), ...override })).toThrowError(
      expect.objectContaining({ code: "INVALID_AUDIT_RECORD" }),
    );
  });

  it("accepts old occurredAt without rewriting it", () => {
    expect(validateAuditRecord(record(), Date.parse("2030-01-01T00:00:00.000Z")).occurredAt).toBe(
      record().occurredAt,
    );
  });

  it("fails closed on an invalid locked head or lost guarded advance", async () => {
    const invalidHead = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            next_sequence: "2",
            previous_hash: null,
            recorded_at: "2026-07-27T12:01:02.003Z",
          },
        ],
      });
    await expect(appendAuditRecordInTransaction({ query: invalidHead }, record())).rejects.toThrow(
      AuditPersistenceError,
    );

    const lostAdvance = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            next_sequence: "1",
            previous_hash: null,
            recorded_at: "2026-07-27T12:01:02.003Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(appendAuditRecordInTransaction({ query: lostAdvance }, record())).rejects.toThrow(
      AuditPersistenceError,
    );
  });
});
