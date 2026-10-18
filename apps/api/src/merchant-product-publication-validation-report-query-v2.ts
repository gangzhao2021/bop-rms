import { BrowserSessionError } from "@bop/identity";
import {
  CatalogError,
  createPostgresProductPublicationValidationReportSourceV2,
  parseCatalogProductPublicationValidationReportReadRequest,
  parseCatalogProductPublicationValidationReportView,
  productPublicationValidationReportReadFields,
  productEditorSnapshotFields,
  productPublicationSourceFieldsV2,
  parseCatalogInstant,
} from "@rms/catalog";
import {
  createMerchantProductCategoryAssignments,
  type MerchantProductCategoryPolicy,
} from "./merchant-product-category-assignments.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { createMerchantProductPublicationRuntimeReadAuthority } from "./merchant-product-publication-runtime-read-authority.js";

type SourceOptions = Parameters<typeof createPostgresProductPublicationValidationReportSourceV2>[0];
type Transaction = Parameters<SourceOptions["reportAuthority"]["holdUntilTransactionCompletes"]>[0];
type View = ReturnType<typeof parseCatalogProductPublicationValidationReportView>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const denied = (): never => {
  throw new CatalogError("CATALOG_PERMISSION_DENIED");
};

/** Private read composition only. The Catalog facade owns the one physical
 * editor/history/report transaction; persisted validation is never current
 * publication eligibility or permission to acknowledge warnings. */
export function createMerchantProductPublicationValidationReportQueryV2(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly currentRuntime?: true;
  readonly contentAuthority?: SourceOptions["contentAuthority"];
  readonly historyAuthority?: SourceOptions["historyAuthority"];
  readonly reportAuthority?: SourceOptions["reportAuthority"];
  readonly categoryPolicy?: MerchantProductCategoryPolicy;
  readonly holdScreenUntilCommit?: (
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly sessionReference: string;
      readonly productReference: string;
      readonly versionReference: string;
      readonly screenId: "CAT-PRODUCT-EDIT";
      readonly capability: "catalog.cat_product_edit";
      readonly permission: "catalog.manage";
      readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ";
      readonly requiredFields: typeof productPublicationValidationReportReadFields;
      readonly contentFields: typeof productEditorSnapshotFields;
      readonly historyFields: typeof productPublicationSourceFieldsV2;
      readonly observedAt: string;
    },
  ) => Promise<void>;
}) {
  const merchant = { ...options.merchant },
    authentication = options.authentication?.authorize?.bind(options.authentication),
    suppliedContentAuthority = options.contentAuthority?.holdUntilTransactionCompletes?.bind(
      options.contentAuthority,
    ),
    suppliedHistoryAuthority = options.historyAuthority?.holdUntilTransactionCompletes?.bind(
      options.historyAuthority,
    ),
    suppliedReportAuthority = options.reportAuthority?.holdUntilTransactionCompletes?.bind(
      options.reportAuthority,
    ),
    suppliedScreen = options.holdScreenUntilCommit?.bind(options),
    currentRuntime = options.currentRuntime === true,
    categoryPolicy = options.categoryPolicy,
    clock = merchant.now?.bind(options.merchant),
    run = merchant.transactions?.run?.bind(merchant.transactions);
  if (
    typeof authentication !== "function" ||
    (options.currentRuntime !== undefined && options.currentRuntime !== true) ||
    (currentRuntime
      ? options.contentAuthority !== undefined ||
        options.historyAuthority !== undefined ||
        options.reportAuthority !== undefined ||
        options.holdScreenUntilCommit !== undefined
      : typeof suppliedContentAuthority !== "function" ||
        typeof suppliedHistoryAuthority !== "function" ||
        typeof suppliedReportAuthority !== "function" ||
        typeof suppliedScreen !== "function") ||
    typeof clock !== "function" ||
    typeof run !== "function"
  )
    return fail();
  const resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions({ run });
  return async (input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly query: unknown;
    readonly expectedScope: unknown;
  }): Promise<View> => {
    const expected = parseMerchantProductCommandScope(input.expectedScope);
    let query: ReturnType<typeof parseCatalogProductPublicationValidationReportReadRequest>;
    try {
      query = parseCatalogProductPublicationValidationReportReadRequest(input.query);
    } catch {
      throw new CatalogError("CATALOG_INPUT_INVALID");
    }
    let lastAt = "",
      clockFailed = false,
      originalValidUntil: string | undefined;
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (
          clockFailed ||
          (lastAt && at < lastAt) ||
          (originalValidUntil && at >= originalValidUntil)
        )
          return fail();
        lastAt = at;
        return at;
      } catch {
        clockFailed = true;
        return fail();
      }
    };
    try {
      const session = await authentication(input);
      if (currentRuntime) originalValidUntil = new Date(Date.parse(now()) + 5000).toISOString();
      let transactions = 0,
        callbacks = 0,
        completed: { readonly view: View } | undefined;
      const result = await host.transactions.run(async (tx) => {
        if (++transactions !== 1) return fail();
        const scope = await resolve(tx, input.sessionCookie, session.sessionReference),
          brandReference = scope.context.brand.brandReference;
        bindMerchantProductCommandScope(
          { brandReference, storeReference: scope.selectedStoreReference },
          expected,
        );
        const bridge = currentRuntime
          ? createMerchantProductCurrentAuthorization({
              merchant,
              transaction: tx,
              scope,
              sessionCookie: input.sessionCookie,
              sessionReference: session.sessionReference,
              clock: { now },
              originalValidUntil: originalValidUntil ?? fail(),
            })
          : undefined;
        const runtimeHost = bridge
          ? {
              transaction: tx,
              tenantReference: scope.tenantReference,
              brandReference,
              storeReference: scope.selectedStoreReference,
              actorReference: scope.actorReference,
              clock: { now },
              originalValidUntil: originalValidUntil ?? fail(),
              currentAuthorization: bridge,
              registerBeforeCommit: host.registerBeforeCommit,
            }
          : undefined;
        const runtime = runtimeHost
          ? createMerchantProductPublicationRuntimeReadAuthority({
              ...runtimeHost,
              query: { kind: "ValidationReport", request: query },
            })
          : undefined;
        const capability = runtimeHost
          ? createMerchantProductStoreCapabilityGuard(runtimeHost)
          : undefined;
        const contentAuthority =
            runtime?.contentAuthority.holdUntilTransactionCompletes ??
            suppliedContentAuthority ??
            fail(),
          historyAuthority =
            runtime?.historyAuthority.holdUntilTransactionCompletes ??
            suppliedHistoryAuthority ??
            fail(),
          reportAuthority =
            runtime?.reportAuthority.holdUntilTransactionCompletes ??
            suppliedReportAuthority ??
            fail();
        let poisoned = false,
          observed: View | undefined,
          contentInput:
            | Parameters<SourceOptions["contentAuthority"]["holdUntilTransactionCompletes"]>[1]
            | undefined,
          historyInput:
            | Parameters<SourceOptions["historyAuthority"]["holdUntilTransactionCompletes"]>[1]
            | undefined,
          reportInput:
            | Parameters<SourceOptions["reportAuthority"]["holdUntilTransactionCompletes"]>[1]
            | undefined;
        const reject = (): never => {
          poisoned = true;
          return fail();
        };
        const authorize = async () => {
          const actions = [
            "catalog.manage",
            "catalog.product.manage",
            "catalog.product.read",
            "catalog.sku.read",
            "catalog.product.history.read",
          ];
          if (bridge && capability) {
            await bridge.authorizeActions(actions);
            await capability.holdUntilCommit();
            bridge.assertCurrent();
            return;
          }
          for (const action of actions) {
            const decision = await scope.authorizeAction(action);
            if (
              decision?.effect !== "Allow" ||
              decision.action !== action ||
              decision.scopeKind !== "Brand"
            )
              return denied();
          }
          const held = await (suppliedScreen ?? fail())(tx, {
            tenantReference: scope.tenantReference,
            brandReference,
            storeReference: scope.selectedStoreReference,
            actorReference: scope.actorReference,
            sessionReference: session.sessionReference,
            productReference: query.productReference,
            versionReference: query.versionReference,
            screenId: "CAT-PRODUCT-EDIT",
            capability: "catalog.cat_product_edit",
            permission: "catalog.manage",
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ",
            requiredFields: productPublicationValidationReportReadFields,
            contentFields: productEditorSnapshotFields,
            historyFields: productPublicationSourceFieldsV2,
            observedAt: now(),
          });
          if (held !== undefined) return reject();
          now();
        };
        const check = () => {
          bridge?.assertCurrent();
          runtime?.assertCurrent();
          const at = now();
          if (poisoned || !observed || at < observed.observedAt || at >= observed.validUntil)
            return reject();
        };
        await host.registerBeforeCommit(
          tx,
          async () => {
            check();
            await authorize();
            if (!contentInput || !historyInput || !reportInput) return reject();
            if ((await contentAuthority(tx, contentInput)) !== undefined) return reject();
            if ((await historyAuthority(tx, historyInput)) !== undefined) return reject();
            if ((await reportAuthority(tx, reportInput)) !== undefined) return reject();
            check();
          },
          check,
        );
        await authorize();
        const categoryAssignments = createMerchantProductCategoryAssignments({
          transaction: tx,
          tenantReference: scope.tenantReference,
          brandReference,
          actorReference: scope.actorReference,
          now,
          policy: categoryPolicy,
          registerBeforeCommit: host.registerBeforeCommit,
        });
        const source = createPostgresProductPublicationValidationReportSourceV2({
          tenantReference: scope.tenantReference,
          brandReference,
          storeReference: scope.selectedStoreReference,
          actorReference: scope.actorReference,
          clock: { now },
          transactions: { run: (work) => work(tx) },
          registerBeforeCommit: async (actual, guard, finalAssert) => {
            if (actual !== tx) return reject();
            await host.registerBeforeCommit(tx, guard, finalAssert);
          },
          contentAuthority: {
            async holdUntilTransactionCompletes(actual, request) {
              if (actual !== tx) return reject();
              contentInput = request;
              if ((await contentAuthority(tx, request)) !== undefined) return reject();
            },
          },
          historyAuthority: {
            async holdUntilTransactionCompletes(actual, request) {
              if (actual !== tx) return reject();
              historyInput = request;
              if ((await historyAuthority(tx, request)) !== undefined) return reject();
            },
          },
          reportAuthority: {
            async holdUntilTransactionCompletes(actual, request) {
              if (actual !== tx) return reject();
              reportInput = request;
              if ((await reportAuthority(tx, request)) !== undefined) return reject();
            },
          },
          ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
        });
        const view = await source.withCurrentReport(query, async (value, actual) => {
          if (++callbacks !== 1 || actual !== tx) return reject();
          const parsed = parseCatalogProductPublicationValidationReportView(value);
          if (
            parsed.tenantReference !== scope.tenantReference ||
            parsed.brandReference !== brandReference ||
            parsed.storeReference !== scope.selectedStoreReference ||
            parsed.productReference !== query.productReference ||
            parsed.versionReference !== query.versionReference ||
            parsed.aggregateVersion !== query.expectedAggregateVersion ||
            parsed.publicationVersion !== query.expectedPublicationVersion
          )
            return reject();
          observed = parsed;
          check();
          return parsed;
        });
        if (callbacks !== 1 || view !== observed) return fail();
        check();
        completed = Object.freeze({ view });
        return completed;
      });
      if (transactions !== 1 || callbacks !== 1 || !completed || result !== completed)
        return fail();
      const at = now();
      if (at < completed.view.observedAt || at >= completed.view.validUntil) return fail();
      return completed.view;
    } catch (error) {
      if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED")
        return denied();
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  };
}
