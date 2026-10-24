import { it, expect, vi } from "vitest";
import {
  parseCategoryOperationRecord,
  validateCategoryPersistenceWrite,
  validateCategoryTreeSnapshot,
} from "../index.js";
const id = (n: number) => `01909900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-28T12:00:00.000Z";
const category = (n = 1, more: Record<string, unknown> = {}) => ({
  categoryReference: id(n),
  brandReference: id(100),
  internalCode: `CAT_${n}`,
  lifecycle: "Draft",
  aggregateVersion: 1,
  defaultLocale: "en-CA",
  localizedNames: { "en-CA": "Synthetic category" },
  localizedDescriptions: {},
  parentCategoryReference: null,
  level: 1,
  sortOrder: n,
  storeReferences: [],
  createdAt: at,
  createdByActorReference: id(101),
  updatedAt: at,
  ...more,
});
const operation = (action = "Create", aggregate = category()) => ({
  action,
  operationReference: id(102),
  operationIntentHash: "1".repeat(64),
  aggregate,
});
const audit = (action = "Create") => ({
  auditId: id(103),
  brandId: id(100),
  actor: { type: "User", reference: id(101) },
  actionCode: `CATALOG_CATEGORY_${action.toUpperCase()}`,
  targetType: "CatalogCategory",
  targetId: id(1),
  beforeSummary: {},
  afterSummary: {},
  reasonCode: "AUTHORIZED_OPERATION",
  correlationId: id(104),
  occurredAt: at,
  sourceChannel: "API",
  dataClassification: "Internal",
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
});
const scope = { brandReference: id(100), actorReference: id(101), observedAt: at };
const write = (action = "Create", aggregate = category(), expected: number | null = null) => ({
  record: operation(action, aggregate),
  expectedAggregateVersion: expected,
  audit: audit(action),
});
it("copies source descriptors without invoking localized getters", () => {
  const getter = vi.fn(() => "Synthetic hidden name"),
    value = operation();
  Object.defineProperty(value.aggregate.localizedNames, "fr-CA", { enumerable: true, get: getter });
  expect(() => parseCategoryOperationRecord(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("preserves actual original source identity and deterministic digest", () => {
  const original = write();
  const parsed = validateCategoryPersistenceWrite(original, null, scope);
  expect(parsed).toMatchObject({ eventType: "CategoryCreated", expectedAggregateVersion: null });
  expect(parsed.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  original.record.aggregate.localizedNames["en-CA"] = "Changed after parsing";
  expect(parsed.record.aggregate.localizedNames["en-CA"]).toBe("Synthetic category");
});
it.each([
  { brandReference: id(200) },
  { actorReference: id(200) },
  { observedAt: "2026-09-28T11:59:59.999Z" },
])("rejects current actor/Brand/future mismatch %j", (change) => {
  expect(() => validateCategoryPersistenceWrite(write(), null, { ...scope, ...change })).toThrow();
});
it.each([
  { actionCode: "CATALOG_CATEGORY_MOVE" },
  { targetId: id(99) },
  { storeId: id(99) },
  { actor: { type: "System", reference: id(101) } },
])("rejects mismatched audit authority %j", (change) => {
  expect(() =>
    validateCategoryPersistenceWrite({ ...write(), audit: { ...audit(), ...change } }, null, scope),
  ).toThrow();
});
it("enforces locked expected version independently of a pre-inspection", () => {
  expect(() =>
    validateCategoryPersistenceWrite(
      write("Move", category(1, { aggregateVersion: 2, sortOrder: 2 }), 1),
      category(1, { aggregateVersion: 2 }),
      scope,
    ),
  ).toThrow(expect.objectContaining({ code: "CATALOG_VERSION_CONFLICT" }));
});
it.each([
  { localizedNames: { "en-CA": "Injected renamed category" } },
  { lifecycle: "Active" },
  { createdByActorReference: id(99) },
  { storeReferences: [id(99)] },
  { internalCode: "OTHER" },
])("a tree move cannot change other owning facts %j", (change) => {
  expect(() =>
    validateCategoryPersistenceWrite(
      write("Move", category(1, { aggregateVersion: 2, sortOrder: 2, ...change }), 1),
      category(),
      scope,
    ),
  ).toThrow();
});
it("a lifecycle action cannot change tree or localized content", () => {
  expect(() =>
    validateCategoryPersistenceWrite(
      write(
        "ChangeLifecycle",
        category(1, { aggregateVersion: 2, lifecycle: "Active", sortOrder: 2 }),
        1,
      ),
      category(),
      scope,
    ),
  ).toThrow();
  expect(
    validateCategoryPersistenceWrite(
      write("ChangeLifecycle", category(1, { aggregateVersion: 2, lifecycle: "Active" }), 1),
      category(),
      scope,
    ).eventType,
  ).toBe("CategoryUpdated");
  expect(() =>
    validateCategoryPersistenceWrite(
      write("ChangeLifecycle", category(1, { aggregateVersion: 2, lifecycle: "Archived" }), 1),
      category(1, { lifecycle: "Active" }),
      scope,
    ),
  ).toThrow(expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }));
});
it("distinguishes accepted move and reorder Events", () => {
  expect(
    validateCategoryPersistenceWrite(
      write(
        "Move",
        category(1, { aggregateVersion: 2, parentCategoryReference: id(2), level: 2 }),
        1,
      ),
      category(),
      scope,
    ).eventType,
  ).toBe("CategoryMoved");
  expect(
    validateCategoryPersistenceWrite(
      write("Move", category(1, { aggregateVersion: 2, sortOrder: 2 }), 1),
      category(),
      scope,
    ).eventType,
  ).toBe("CategoryReordered");
});
it("validates a complete three-level Brand source graph", () => {
  const nodes = [
    category(),
    category(2, { parentCategoryReference: id(1), level: 2 }),
    category(3, { parentCategoryReference: id(2), level: 3 }),
  ];
  expect(validateCategoryTreeSnapshot(nodes, id(100), 3)).toHaveLength(3);
  expect(() => validateCategoryTreeSnapshot(nodes, id(100), 2)).toThrow();
});
it.each(
  [
    [category(), category()],
    [category(), category(2, { brandReference: id(99) })],
    [category(), category(2, { internalCode: "CAT_1" })],
    [category(), category(2, { sortOrder: 1 })],
    [category(1, { parentCategoryReference: id(99), level: 2 })],
    [
      category(1, { parentCategoryReference: id(2), level: 2 }),
      category(2, { parentCategoryReference: id(1), level: 2 }),
    ],
    [category(), category(2, { parentCategoryReference: id(1), level: 3 })],
  ].map((nodes) => ({ nodes })),
)("rejects incomplete/corrupt Brand tree %j", ({ nodes }) => {
  expect(() => validateCategoryTreeSnapshot(nodes, id(100), 10)).toThrow();
});
it("rejects sparse/accessor source arrays and no partial snapshot", () => {
  const getter = vi.fn(() => category());
  const nodes: unknown[] = [];
  Object.defineProperty(nodes, "0", { enumerable: true, get: getter });
  expect(() => validateCategoryTreeSnapshot(nodes, id(100), 10)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() => validateCategoryTreeSnapshot(new Array(2), id(100), 10)).toThrow();
});

it("retains public Audit optional undefined fields without accepting unknown facts", () => {
  expect(
    validateCategoryPersistenceWrite(
      {
        ...write(),
        audit: {
          ...audit(),
          storeId: undefined,
          beforeSummary: undefined,
          afterSummary: undefined,
        },
      },
      null,
      scope,
    ).eventType,
  ).toBe("CategoryCreated");
  expect(() =>
    validateCategoryPersistenceWrite(
      { ...write(), record: { ...operation(), unexpected: undefined } },
      null,
      scope,
    ),
  ).toThrow();
});
