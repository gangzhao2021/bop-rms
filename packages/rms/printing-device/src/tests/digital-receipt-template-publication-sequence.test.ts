import { expect, it, vi } from "vitest";
import {
  createPostgresDigitalReceiptTemplateStore,
  type ReceiptTemplateTransaction,
} from "../infrastructure/persistence/digital-receipt-template-store.js";
import { digitalReceiptRequiredFields } from "../contracts/digital-receipt-template.js";

const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T12:00:00.000Z";
function row(number: number, override: Record<string, unknown> = {}) {
  const version = {
    templateReference: id(1),
    versionReference: id(100 + number),
    versionNumber: number,
    versionCode: `RECEIPT_${number}`,
    brandReference: id(3),
    storeReference: id(4),
    locale: "en-CA",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    layoutDefinitionReference: id(5),
    complianceRuleReference: id(6),
    requiredFields: [...digitalReceiptRequiredFields],
    publicationReference: id(200 + number),
    publishedAt: at,
    effectiveFrom: at,
    effectiveUntil: null,
    ...override,
  };
  return {
    version_id: version.versionReference,
    template_id: version.templateReference,
    version_number: String(version.versionNumber),
    version_code: version.versionCode,
    publication_id: version.publicationReference,
    published_at: at,
    version_json: version,
  };
}
function fixture(rows: readonly Record<string, unknown>[] = []) {
  // Controlled owning rows; this is not native persistence or current-release proof.
  const authorize = vi.fn(async () => true),
    current = vi.fn(async () => false),
    options = {
      brandReference: id(3),
      storeReference: id(4),
      authorize,
      validatePublication: async () => false,
      isCurrentPublication: current,
    };
  const tx: ReceiptTemplateTransaction = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT version_id") ? rows : [],
      rowCount: rows.length,
    })),
  };
  const store = createPostgresDigitalReceiptTemplateStore(options);
  return { store, tx, options, authorize, current };
}
it.each([0, 1, 3])(
  "allocates the next actual publication number from %s immutable versions",
  async (count) => {
    const f = fixture(Array.from({ length: count }, (_, i) => row(i + 1)));
    const result = await f.store.readPublicationSequence(f.tx, { templateReference: id(1) });
    expect(result).toEqual({
      profile: "DigitalReceiptTemplatePublicationSequenceV1",
      brandReference: id(3),
      storeReference: id(4),
      templateReference: id(1),
      nextVersionNumber: count + 1,
      latestVersionReference: count ? id(100 + count) : null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(f.current).not.toHaveBeenCalled();
    expect(vi.mocked(f.tx.query).mock.calls[1]?.[1]).toEqual([
      `ReceiptTemplate:${id(3)}:${id(4)}:${id(1)}`,
    ]);
  },
);
it.each(
  [
    [row(2)],
    [row(1), row(3)],
    [row(1), row(1)],
    [row(1, { brandReference: id(10) })],
    [row(1, { storeReference: id(10) })],
    [row(1, { templateReference: id(10) })],
    Array.from({ length: 100 }, (_, i) => row(i + 1)),
  ].map((rows) => ({ rows })),
)("refuses corrupt, foreign or exhausted history", async ({ rows }) => {
  const f = fixture(rows);
  await expect(
    f.store.readPublicationSequence(f.tx, { templateReference: id(1) }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
});
it("refuses admission and late authorization withdrawal", async () => {
  const early = fixture();
  early.authorize.mockResolvedValue(false);
  await expect(
    early.store.readPublicationSequence(early.tx, { templateReference: id(1) }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" });
  expect(early.tx.query).not.toHaveBeenCalled();
  const late = fixture();
  late.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    late.store.readPublicationSequence(late.tx, { templateReference: id(1) }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" });
});
it("rejects callback drift before returning an allocation input", async () => {
  const f = fixture();
  f.authorize.mockImplementationOnce(async () => {
    f.options.authorize = vi.fn(async () => true);
    return true;
  });
  await expect(
    f.store.readPublicationSequence(f.tx, { templateReference: id(1) }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
  expect(f.tx.query).not.toHaveBeenCalled();
});
it("rejects getter and extraneous query fields", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(1));
  const forged = Object.defineProperty({}, "templateReference", { enumerable: true, get: getter });
  await expect(
    f.store.readPublicationSequence(f.tx, forged as { templateReference: string }),
  ).rejects.toBeDefined();
  await expect(
    f.store.readPublicationSequence(f.tx, { templateReference: id(1), nextVersionNumber: 1 } as {
      templateReference: string;
    }),
  ).rejects.toBeDefined();
  expect(getter).not.toHaveBeenCalled();
  expect(f.tx.query).not.toHaveBeenCalled();
});
