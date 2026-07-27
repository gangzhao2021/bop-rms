import { describe, expect, it, vi } from "vitest";
import { appendAuditRecordInTransaction, validateAuditRecord } from "../index.js";

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
  it("validates and performs exactly one parameterized insert", async () => {
    const query = vi.fn().mockResolvedValue({});
    await appendAuditRecordInTransaction({ query }, record());
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO platform_audit.audit_record");
    expect(query.mock.calls[0]?.[1]).toHaveLength(19);
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
});
