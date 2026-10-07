import { canonicalizeRfc8785 } from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  CatalogOptionSetListError,
  copyCategoryPersistenceValue,
  createPostgresOptionSetListQueryStore,
  parseOptionSetListRequest,
  parseOptionSetListView,
  optionSetListFields,
  parseCatalogInstant,
  parseCatalogReference,
  type OptionSetListView,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
export interface MerchantOptionSetListQueryOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly cursorKey: Uint8Array;
}
const fail = (code: CatalogOptionSetListError["code"] = "DependencyUnavailable"): never => {
  throw new CatalogOptionSetListError(code);
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
/** Ordinary live authoring list only. Catalog owns SQL/search/generation/cursor;
 * current PublishingStatus and reference eligibility are not supplied here. */
export function createMerchantOptionSetListQuery(options: MerchantOptionSetListQueryOptions) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    !(options.cursorKey instanceof Uint8Array) ||
    options.cursorKey.length < 32 ||
    options.cursorKey.length > 64
  )
    return fail();
  const cursorKey = new Uint8Array(options.cursorKey),
    clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication);
  const merchant = Object.freeze({
      ...options.merchant,
      now: clock,
      transactions: { run },
      ...(options.merchant.validateAssociation
        ? { validateAssociation: options.merchant.validateAssociation.bind(options.merchant) }
        : {}),
      ...(options.merchant.currentActor
        ? { currentActor: options.merchant.currentActor.bind(options.merchant) }
        : {}),
    }),
    resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions({ run });
  return async (request: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly filters: unknown;
    readonly expectedScope: unknown;
  }): Promise<OptionSetListView> => {
    const filters = parseOptionSetListRequest(request.filters),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let expected: ReturnType<typeof parseMerchantProductCommandScope>;
    try {
      expected = parseMerchantProductCommandScope(request.expectedScope);
    } catch {
      return fail("Invalid");
    }
    let latest: string,
      failed = false;
    try {
      latest = parseCatalogInstant(clock());
    } catch {
      return fail();
    }
    const startedAt = latest,
      originalDeadline = new Date(Date.parse(startedAt) + 5000).toISOString();
    let deadline = originalDeadline;
    const poison = (): never => {
      failed = true;
      return fail();
    };
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (failed || at < latest || at >= deadline) return poison();
        latest = at;
        return at;
      } catch {
        return poison();
      }
    };
    const bounded = (error: unknown): never => {
      failed = true;
      if (error instanceof CatalogOptionSetListError) throw error;
      if (error instanceof MerchantProductWriteFeatureDisabled) return fail("FeatureDisabled");
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
        return fail("Denied");
      return fail();
    };
    try {
      const session = await authenticate({ sessionCookie, csrf }).catch((error: unknown) => {
        if (error instanceof BrowserSessionError) return fail("Denied");
        return fail();
      });
      now();
      let calls = 0,
        finalized = false,
        completed: OptionSetListView | undefined,
        afterCommit: (() => void) | undefined;
      const result = await host.transactions.run(async (tx) => {
        if (++calls !== 1) return poison();
        const query = tx.query;
        let ready = false,
          admissionActive = false,
          guardStarted = false,
          guardComplete = false,
          finalCalls = 0,
          admitted = false;
        let assertSources: (() => void) | undefined, rehold: (() => Promise<void>) | undefined;
        const check = () => {
          now();
          if (tx.query !== query) return poison();
          assertSources?.();
        };
        await host.registerBeforeCommit(
          tx,
          async () => {
            if (!ready || admissionActive || guardStarted || !rehold) return poison();
            guardStarted = true;
            try {
              await rehold();
              check();
              guardComplete = true;
            } catch (error) {
              return bounded(error);
            }
          },
          () => {
            if (!ready || admissionActive || !guardStarted || !guardComplete || ++finalCalls !== 1)
              return poison();
            check();
            finalized = true;
          },
        );
        try {
          const scope = await resolve(tx, sessionCookie, session.sessionReference);
          check();
          const selected = bindMerchantProductCommandScope(
              {
                brandReference: scope.context.brand.brandReference,
                storeReference: scope.selectedStoreReference,
              },
              expected,
            ),
            identity = Object.freeze({
              tenantReference: parseCatalogReference(scope.tenantReference),
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              actorReference: parseCatalogReference(scope.actorReference),
            });
          const current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            capabilityKey: "catalog.cat_optionset_list",
          });
          const capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            ...identity,
            clock: { now },
            originalValidUntil: originalDeadline,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey: "catalog.cat_optionset_list",
          });
          if (
            typeof current.leaseDeadline !== "function" ||
            typeof capability.leaseDeadline !== "function" ||
            typeof current.authorizeActions !== "function" ||
            typeof current.assertCurrent !== "function" ||
            typeof capability.holdUntilCommit !== "function"
          )
            return poison();
          const assert = current.assertCurrent.bind(current),
            authorize = current.authorizeActions.bind(current),
            currentLease = current.leaseDeadline.bind(current),
            featureLease = capability.leaseDeadline.bind(capability),
            holdFeature = capability.holdUntilCommit.bind(capability);
          assertSources = () => {
            try {
              parseCatalogInstant(assert());
              if (admitted) {
                const a = parseCatalogInstant(currentLease()),
                  b = parseCatalogInstant(featureLease());
                if (a < deadline) deadline = a;
                if (b < deadline) deadline = b;
                now();
              }
            } catch (error) {
              return bounded(error);
            }
          };
          rehold = async () => {
            if (admissionActive || finalized) return poison();
            admissionActive = true;
            try {
              check();
              if ((await holdFeature()) !== undefined) return poison();
              admitted = true;
              check();
              if (
                (await authorize(Object.freeze(["catalog.manage", "catalog.option_set.read"]))) !==
                undefined
              )
                return poison();
              check();
            } catch (error) {
              return bounded(error);
            } finally {
              admissionActive = false;
            }
          };
          await rehold();
          check();
          const store = createPostgresOptionSetListQueryStore({
            ...identity,
            cursorKey,
            clock: { now },
            originalValidUntil: originalDeadline,
            transactions: host.transactions,
            registerBeforeCommit: (candidate, guard, final) => {
              if (candidate !== tx) return poison();
              return host.registerBeforeCommit(tx, guard, final);
            },
            authority: {
              async holdUntilTransactionCompletes(actual, input) {
                try {
                  check();
                  if (actual !== tx || admissionActive || finalized || !rehold) return poison();
                  const proof = readClosedRecord(copyCategoryPersistenceValue(input), [
                      "tenantReference",
                      "brandReference",
                      "storeReference",
                      "actorReference",
                      "actorKind",
                      "permission",
                      "requiredPermissions",
                      "purposeCode",
                      "capability",
                      "requiredFields",
                      "request",
                      "observedAt",
                    ]),
                    observedAt = parseCatalogInstant(proof.observedAt);
                  let originalRequest: ReturnType<typeof parseOptionSetListRequest>;
                  try {
                    originalRequest = parseOptionSetListRequest(proof.request);
                  } catch {
                    return poison();
                  }
                  if (
                    proof.tenantReference !== identity.tenantReference ||
                    proof.brandReference !== identity.brandReference ||
                    proof.storeReference !== identity.storeReference ||
                    proof.actorReference !== identity.actorReference ||
                    proof.actorKind !== "User" ||
                    proof.permission !== "catalog.manage" ||
                    proof.purposeCode !== "CATALOG_OPTION_SET_LIST" ||
                    proof.capability !== "catalog.cat_optionset_list" ||
                    !equal(proof.requiredPermissions, [
                      "catalog.manage",
                      "catalog.option_set.read",
                    ]) ||
                    !equal(proof.requiredFields, optionSetListFields) ||
                    !equal(originalRequest, filters) ||
                    observedAt < startedAt ||
                    observedAt > now()
                  )
                    return poison();
                  await rehold();
                  check();
                  return Object.freeze({ observedAt, validUntil: deadline });
                } catch (error) {
                  return bounded(error);
                }
              },
            },
          });
          const raw = await store.loadInTransaction(tx, filters);
          check();
          let view: OptionSetListView;
          try {
            view = parseOptionSetListView(raw);
          } catch {
            return poison();
          }
          if (
            !equal(view.scope, identity) ||
            view.locale !== filters.locale ||
            view.projection.asOfUtc < startedAt ||
            view.projection.asOfUtc > now() ||
            view.items.length > filters.limit ||
            view.hasMore !== Boolean(view.nextCursor) ||
            view.items.some(
              (i) =>
                i.referenceEligibility !== "NotEvaluated" ||
                i.publishingStatus.status !== "Unavailable",
            )
          )
            return poison();
          completed = view;
          ready = true;
          check();
          afterCommit = () => {
            check();
            store.assertFinalized(tx);
            check();
          };
          return view;
        } catch (error) {
          return bounded(error);
        }
      });
      if (calls !== 1 || !finalized || !completed || result !== completed || !afterCommit)
        return poison();
      now();
      afterCommit();
      now();
      return result;
    } catch (error) {
      return bounded(error);
    }
  };
}
