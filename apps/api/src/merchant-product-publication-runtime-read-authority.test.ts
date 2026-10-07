import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseCatalogProductPublicationValidationReportReadRequest,
  parseProductPublicationSourceRequest,
  productEditorSnapshotFields,
  productPublicationSourceFieldsV2,
  productPublicationValidationReportReadFields,
} from "@rms/catalog";
import {
  createMerchantProductPublicationRuntimeReadAuthority,
  type MerchantProductPublicationRuntimeReadAuthorityOptions,
} from "./merchant-product-publication-runtime-read-authority.js";

const id = (n: number) => "01902495-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z";
type Options = MerchantProductPublicationRuntimeReadAuthorityOptions;
type Tx = Options["transaction"];
const common = {
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  actorKind: "User" as const,
  productReference: id(4),
  permission: "catalog.manage" as const,
  observedAt: at,
};
const content = {
  ...common,
  purposeCode: "CATALOG_PRODUCT_EDITOR_READ" as const,
  owningAction: "catalog.product.manage" as const,
  requiredFields: productEditorSnapshotFields,
};
const history = {
  ...common,
  purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE" as const,
  owningActions: ["catalog.product.history.read"] as const,
  requiredFields: productPublicationSourceFieldsV2,
};
const report = {
  ...common,
  versionReference: id(5),
  expectedAggregateVersion: 7,
  expectedPublicationVersion: 2,
  purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ" as const,
  owningActions: ["catalog.product.read", "catalog.product.history.read"] as const,
  requiredScope: "FullBrandScope" as const,
  requiredFields: productPublicationValidationReportReadFields,
};
function fixture(kind: "Management" | "ValidationReport" = "ValidationReport") {
  let now = at;
  const tx: Tx = { query: vi.fn(async () => ({ rows: [] })) },
    guards: { async: () => Promise<void>; final: () => void }[] = [],
    authorize = vi.fn<Options["currentAuthorization"]["authorizeActions"]>(async () => undefined),
    options: Options = {
      transaction: tx,
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      query:
        kind === "Management"
          ? {
              kind,
              request: parseProductPublicationSourceRequest({
                productReference: id(4),
                expectedAggregateVersion: 7,
              }),
            }
          : {
              kind,
              request: parseCatalogProductPublicationValidationReportReadRequest({
                productReference: id(4),
                versionReference: id(5),
                expectedAggregateVersion: 7,
                expectedPublicationVersion: 2,
              }),
            },
      clock: { now: () => now },
      originalValidUntil: until,
      currentAuthorization: {
        authorizeActions: authorize,
        async withCurrentStoreScope() {
          throw new Error("Read profiles do not resolve Store scope independently");
        },
      },
      async registerBeforeCommit(actual, asyncGuard, finalAssert) {
        expect(actual).toBe(tx);
        guards.push({ async: asyncGuard, final: finalAssert });
      },
    },
    source = createMerchantProductPublicationRuntimeReadAuthority(options);
  return {
    tx,
    guards,
    authorize,
    source,
    options,
    setNow(value: string) {
      now = value;
    },
  };
}
it("holds all three exact owner read packets and rechecks their real action union at COMMIT", async () => {
  const f = fixture();
  await f.source.contentAuthority.holdUntilTransactionCompletes(f.tx, content);
  await f.source.historyAuthority.holdUntilTransactionCompletes(f.tx, history);
  await f.source.reportAuthority.holdUntilTransactionCompletes(f.tx, report);
  expect(f.guards).toHaveLength(1);
  await f.guards[0]?.async();
  expect(new Set(f.authorize.mock.calls.at(-1)?.[0])).toEqual(
    new Set([
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.read",
      "catalog.sku.read",
      "catalog.product.history.read",
    ]),
  );
  // A later owner guard legitimately reholds an already admitted profile.
  await f.source.reportAuthority.holdUntilTransactionCompletes(f.tx, report);
  f.guards[0]?.final();
  expect(f.tx.query).not.toHaveBeenCalled();
});
it("management may read editor/history but cannot acquire a report outside its original query", async () => {
  const f = fixture("Management");
  await f.source.contentAuthority.holdUntilTransactionCompletes(f.tx, content);
  await f.source.historyAuthority.holdUntilTransactionCompletes(f.tx, history);
  await expect(
    f.source.reportAuthority.holdUntilTransactionCompletes(f.tx, report),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.guards[0]?.async()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it.each([
  { tenantReference: id(20) },
  { brandReference: id(20) },
  { actorReference: id(20) },
  { productReference: id(20) },
  { versionReference: id(20) },
  { expectedAggregateVersion: 8 },
  { expectedPublicationVersion: 3 },
  { requiredScope: "SelectedStore" },
  { purposeCode: "CATALOG_PRODUCT_EDITOR_READ" },
  { actorKind: "System" },
  { requiredFields: [...productPublicationValidationReportReadFields, "undeclared"] },
  { observedAt: "2026-10-04T11:59:59.999Z" },
  { observedAt: "2026-10-04T12:00:00.001Z" },
  { command: {} },
])("rejects packet drift %j before IAM and installs a rejecting guard", async (changed) => {
  const f = fixture();
  const input = { ...report, ...changed };
  // The transport boundary receives unknown collaborators; invoke without a
  // compile-time assertion so the test exercises runtime closed-profile parsing.
  await expect(
    Reflect.apply(f.source.reportAuthority.holdUntilTransactionCompletes, undefined, [f.tx, input]),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.guards).toHaveLength(1);
  await expect(f.guards[0]?.async()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("does not execute a packet getter and poisons the original host", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(3));
  const input = { ...report };
  Object.defineProperty(input, "actorReference", { enumerable: true, get: getter });
  await expect(
    f.source.reportAuthority.holdUntilTransactionCompletes(f.tx, input),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(getter).not.toHaveBeenCalled();
  await expect(f.guards[0]?.async()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("preserves actual late permission denial and refuses COMMIT", async () => {
  const f = fixture();
  await f.source.reportAuthority.holdUntilTransactionCompletes(f.tx, report);
  f.authorize.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.guards[0]?.async()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(() => f.guards[0]?.final()).toThrow();
});
it("a later awaited guard cannot extend the earlier read's original lease", async () => {
  const f = fixture();
  await f.source.reportAuthority.holdUntilTransactionCompletes(f.tx, report);
  await f.guards[0]?.async();
  await Promise.resolve();
  f.setNow(until);
  expect(() => f.guards[0]?.final()).toThrow();
});
it("caught nested authority acquisition remains poisoned", async () => {
  const f = fixture();
  f.authorize.mockImplementationOnce(async () => {
    await f.source.reportAuthority
      .holdUntilTransactionCompletes(f.tx, report)
      .catch(() => undefined);
  });
  await expect(
    f.source.reportAuthority.holdUntilTransactionCompletes(f.tx, report),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.guards[0]?.async()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("captures authority ports and refuses changed transaction query or new actions during commit", async () => {
  const f = fixture(),
    replaced = vi.fn(async () => {
      throw Error("replacement");
    });
  Object.assign(f.options.currentAuthorization, { authorizeActions: replaced });
  await f.source.reportAuthority.holdUntilTransactionCompletes(f.tx, report);
  expect(replaced).not.toHaveBeenCalled();
  await f.guards[0]?.async();
  await expect(
    f.source.contentAuthority.holdUntilTransactionCompletes(f.tx, content),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  const g = fixture();
  await g.source.reportAuthority.holdUntilTransactionCompletes(g.tx, report);
  Object.assign(g.tx, { query: vi.fn(async () => ({ rows: [] })) });
  await expect(g.guards[0]?.async()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
