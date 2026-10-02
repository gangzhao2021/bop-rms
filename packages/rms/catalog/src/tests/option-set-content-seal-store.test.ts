import { describe, expect, it, vi } from "vitest";
import { CatalogError } from "../contracts/product.js";
import {
  frozenFullOptionSetContentFields,
  createPostgresFullOptionSetContentSealStore,
} from "../infrastructure/persistence/option-set-full-draft-store.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-01T00:00:00.000Z";
const digest = "sha256:" + "a".repeat(64);
const command = {
  optionSetReference: id(4),
  versionReference: id(5),
  expectedAggregateVersion: 1,
  sourceDigest: digest,
  contentDigest: digest,
  configurationDigest: digest,
  operationReference: id(6),
  occurredAt: at,
  reasonCode: "CONFIGURATION_EDIT",
};
function fixture() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const authority = {
    holdUntilTransactionCompletes: vi.fn(async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
  };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => at },
    transactions: {
      run: async <T>(work: (tx: { query: typeof query }) => Promise<T>) => work({ query }),
    },
    authority,
    readAuthority: authority,
    references: { generateSuccessorVersion: () => id(7) },
    audit: {
      create: () => {
        throw new Error("unreached");
      },
    },
    events: { generateReference: () => id(8) },
  };
  return { options, query, authority };
}
describe("full Option atomic content seal boundary", () => {
  it.each([
    "authority",
    "readAuthority",
    "references",
    "audit",
    "events",
    "transactions",
    "clock",
  ] as const)("refuses missing %s before a transaction", (key) => {
    const f = fixture();
    expect(() =>
      createPostgresFullOptionSetContentSealStore({ ...f.options, [key]: undefined } as never),
    ).toThrow(CatalogError);
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    { ...command, eligibility: "Ready" },
    { ...command, content: {} },
    { ...command, expectedAggregateVersion: 2147483647 },
    { ...command, expectedAggregateVersion: 0 },
    { ...command, expectedAggregateVersion: "1" },
    { ...command, sourceDigest: "opaque" },
    { ...command, versionReference: "opaque" },
    { ...command, occurredAt: "2026-10-01T00:00:00.000001Z" },
    { ...command, reasonCode: "configuration edit" },
  ])("rejects untrusted malformed or qualification input before admission", async (value) => {
    const f = fixture();
    await expect(
      createPostgresFullOptionSetContentSealStore(f.options).seal(value),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(f.authority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("never invokes an input getter", async () => {
    const f = fixture(),
      get = vi.fn(() => command.reasonCode),
      value = { ...command };
    Object.defineProperty(value, "reasonCode", { enumerable: true, get });
    await expect(
      createPostgresFullOptionSetContentSealStore(f.options).seal(value),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(get).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("holds exact server publish tuple before any owning SQL", async () => {
    const f = fixture();
    await expect(
      createPostgresFullOptionSetContentSealStore(f.options).seal(command),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.authority.holdUntilTransactionCompletes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        permission: "catalog.manage",
        action: "catalog.option_set.publish",
        purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
        phase: "Intent",
        content: null,
        requiredChecks: [],
        requiredFields: expect.arrayContaining(["optionDetails", "scopeSet", "effectivePeriod"]),
        command,
      }),
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it("captures the owning holder rather than a later injected replacement", async () => {
    const f = fixture(),
      store = createPostgresFullOptionSetContentSealStore(f.options);
    const injected = vi.fn();
    f.options.authority.holdUntilTransactionCompletes = injected;
    await expect(store.seal(command)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(injected).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    { observedAt: at, validUntil: at },
    { observedAt: at, validUntil: "2026-10-01T00:00:31.000Z" },
    { observedAt: at, validUntil: "2026-10-01T00:00:05.000Z", eligibility: "Ready" },
    { observedAt: "2026-10-01T00:00:01.000Z", validUntil: "2026-10-01T00:00:05.000Z" },
  ])("refuses invalid initial lease without SQL", async (evidence) => {
    const f = fixture();
    f.authority.holdUntilTransactionCompletes.mockImplementation(async () => evidence as never);
    await expect(
      createPostgresFullOptionSetContentSealStore(f.options).seal(command),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(f.query).not.toHaveBeenCalled();
  });
});

it("exports the owning complete frozen read fields without a consumer-side map", () => {
  expect(Object.isFrozen(frozenFullOptionSetContentFields)).toBe(true);
  expect(new Set(frozenFullOptionSetContentFields).size).toBe(
    frozenFullOptionSetContentFields.length,
  );
  expect(frozenFullOptionSetContentFields).toEqual([
    "optionSetReference",
    "versionReference",
    "defaultLocale",
    "localizedNames",
    "localizedDescriptions",
    "displayStyle",
    "minimumSelection",
    "maximumSelection",
    "allowRepeatedOption",
    "perOptionMaximumQuantity",
    "maximumTotalQuantity",
    "options",
    "optionDetails",
    "conditionalRules",
    "conflictRules",
    "scopeSet",
    "effectivePeriod",
    "internalCode",
    "brandReference",
    "lifecycle",
    "aggregateVersion",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
    "publicationOperationReference",
    "publicationIntentDigest",
    "successorDraftVersionReference",
    "sealedAt",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "digest",
  ]);
});
