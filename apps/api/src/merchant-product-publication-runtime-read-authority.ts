import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationSourceRequest,
  parseCatalogProductPublicationValidationReportReadRequest,
  productEditorSnapshotFields,
  productPublicationSourceFieldsV2,
  productPublicationValidationReportReadFields,
  type ProductPublicationValidationReportSourceOptionsV2,
} from "@rms/catalog";
import type { MerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";

type Owner = ProductPublicationValidationReportSourceOptionsV2;
type Transaction = Parameters<Owner["reportAuthority"]["holdUntilTransactionCompletes"]>[0];
export interface MerchantProductPublicationRuntimeReadAuthorityOptions {
  readonly transaction: Transaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly query:
    | {
        readonly kind: "Management";
        readonly request: ReturnType<typeof parseProductPublicationSourceRequest>;
      }
    | {
        readonly kind: "ValidationReport";
        readonly request: ReturnType<
          typeof parseCatalogProductPublicationValidationReportReadRequest
        >;
      };
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly currentAuthorization: MerchantProductCurrentAuthorization;
  readonly registerBeforeCommit: Owner["registerBeforeCommit"];
}
const commonFields = [
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "productReference",
  "purposeCode",
  "permission",
  "requiredFields",
  "observedAt",
];
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);

/** Fixed read profiles over current Brand IAM. No report or source packet can
 * grant authority, select another Product, or turn a recorded check into eligibility. */
export function createMerchantProductPublicationRuntimeReadAuthority(
  options: MerchantProductPublicationRuntimeReadAuthorityOptions,
) {
  const tx = options.transaction,
    queryPort = tx.query,
    now = options.clock.now.bind(options.clock),
    authorize = options.currentAuthorization.authorizeActions.bind(options.currentAuthorization),
    register = options.registerBeforeCommit.bind(options),
    tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    query =
      options.query.kind === "Management"
        ? {
            kind: "Management" as const,
            request: parseProductPublicationSourceRequest(options.query.request),
          }
        : options.query.kind === "ValidationReport"
          ? {
              kind: "ValidationReport" as const,
              request: parseCatalogProductPublicationValidationReportReadRequest(
                options.query.request,
              ),
            }
          : (() => {
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            })(),
    startedAt = parseCatalogInstant(now()),
    deadline = parseCatalogInstant(options.originalValidUntil);
  let latest = startedAt,
    failed = false,
    registered = false,
    committing = false,
    checked = false,
    finalCalls = 0,
    active = false;
  const actions = new Set<string>();
  const fail = (error?: unknown): never => {
    failed = true;
    if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (deadline <= startedAt || Date.parse(deadline) - Date.parse(startedAt) > 5000) return fail();
  const assertCurrent = () => {
    try {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== queryPort || at < latest || at >= deadline) return fail();
      latest = at;
    } catch (error) {
      return fail(error);
    }
  };
  const current = async (required: readonly string[]) => {
    try {
      if (active) return fail();
      active = true;
      assertCurrent();
      if ((await authorize(required)) !== undefined) return fail();
      assertCurrent();
    } catch (error) {
      return fail(error);
    } finally {
      active = false;
    }
  };
  const ensureRegistered = async () => {
    if (registered) return;
    registered = true;
    await register(
      tx,
      async () => {
        if (committing || actions.size === 0) return fail();
        committing = true;
        await current([...actions]);
        checked = true;
      },
      () => {
        if (!checked || ++finalCalls !== 1) return fail();
        assertCurrent();
      },
    );
  };
  async function hold(
    actual: Transaction,
    value: unknown,
    extra: readonly string[],
    required: readonly string[],
    validate: (r: Record<string, unknown>) => void,
  ) {
    let captured: Record<string, unknown> | undefined,
      invalid = false;
    try {
      if (
        actual !== tx ||
        active ||
        finalCalls !== 0 ||
        (committing && required.some((action) => !actions.has(action)))
      )
        return fail();
      captured = readClosedRecord(copyCategoryPersistenceValue(value), [...commonFields, ...extra]);
      assertCurrent();
      const at = parseCatalogInstant(captured.observedAt);
      if (
        captured.tenantReference !== tenant ||
        captured.brandReference !== brand ||
        captured.actorReference !== actor ||
        captured.actorKind !== "User" ||
        captured.productReference !== query.request.productReference ||
        captured.permission !== "catalog.manage" ||
        at < startedAt ||
        at > latest
      )
        return fail();
      validate(captured);
    } catch {
      failed = true;
      invalid = true;
    }
    try {
      await ensureRegistered();
      if (invalid || !captured) return fail();
      for (const action of required) actions.add(action);
      await current(required);
    } catch (error) {
      return fail(error);
    }
  }
  const contentAuthority: Owner["contentAuthority"] = Object.freeze({
    holdUntilTransactionCompletes: (
      actual: Transaction,
      value: Parameters<Owner["contentAuthority"]["holdUntilTransactionCompletes"]>[1],
    ) =>
      hold(
        actual,
        value,
        ["owningAction"],
        ["catalog.manage", "catalog.product.manage", "catalog.product.read", "catalog.sku.read"],
        (r) => {
          if (
            r.purposeCode !== "CATALOG_PRODUCT_EDITOR_READ" ||
            r.owningAction !== "catalog.product.manage" ||
            !same(r.requiredFields, productEditorSnapshotFields)
          )
            return fail();
        },
      ),
  });
  const historyAuthority: Owner["historyAuthority"] = Object.freeze({
    holdUntilTransactionCompletes: (
      actual: Transaction,
      value: Parameters<Owner["historyAuthority"]["holdUntilTransactionCompletes"]>[1],
    ) =>
      hold(
        actual,
        value,
        ["owningActions"],
        ["catalog.manage", "catalog.product.history.read"],
        (r) => {
          if (
            r.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_SOURCE" ||
            !same(r.owningActions, ["catalog.product.history.read"]) ||
            !same(r.requiredFields, productPublicationSourceFieldsV2)
          )
            return fail();
        },
      ),
  });
  const reportAuthority: Owner["reportAuthority"] = Object.freeze({
    holdUntilTransactionCompletes: (
      actual: Transaction,
      value: Parameters<Owner["reportAuthority"]["holdUntilTransactionCompletes"]>[1],
    ) =>
      hold(
        actual,
        value,
        [
          "versionReference",
          "expectedAggregateVersion",
          "expectedPublicationVersion",
          "owningActions",
          "requiredScope",
        ],
        ["catalog.manage", "catalog.product.read", "catalog.product.history.read"],
        (r) => {
          if (
            query.kind !== "ValidationReport" ||
            r.versionReference !== query.request.versionReference ||
            r.expectedAggregateVersion !== query.request.expectedAggregateVersion ||
            r.expectedPublicationVersion !== query.request.expectedPublicationVersion ||
            r.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ" ||
            r.requiredScope !== "FullBrandScope" ||
            !same(r.owningActions, ["catalog.product.read", "catalog.product.history.read"]) ||
            !same(r.requiredFields, productPublicationValidationReportReadFields)
          )
            return fail();
        },
      ),
  });
  return Object.freeze({ contentAuthority, historyAuthority, reportAuthority, assertCurrent });
}
