import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
export interface MerchantProductAuthoringContextOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}
export interface MerchantProductAuthoringContext {
  readonly profile: "CatalogProductAuthoringContextV1";
  readonly action: "Create" | "ReplaceDraft";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
/** Read-only authoritative identity for an authoring recovery cursor. Nothing
 * here permits a mutation, renews an original intent or reads its content. */
export function createMerchantProductAuthoringContextQuery(
  options: MerchantProductAuthoringContextOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function"
  )
    return fail();
  const run = options.merchant.transactions.run.bind(options.merchant.transactions),
    clock = options.merchant.now.bind(options.merchant),
    authenticate = options.authentication.authorize.bind(options.authentication),
    merchant = Object.freeze({
      ...options.merchant,
      transactions: { run },
      now: clock,
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
    readonly command: unknown;
    readonly expectedScope: unknown;
  }): Promise<MerchantProductAuthoringContext> => {
    const sessionCookie = request.sessionCookie,
      csrf = request.csrf,
      expected = parseMerchantProductCommandScope(request.expectedScope);
    let action: "Create" | "ReplaceDraft";
    try {
      const raw = readClosedRecord(copyCategoryPersistenceValue(request.command), ["action"]);
      if (raw.action !== "Create" && raw.action !== "ReplaceDraft")
        return fail("CATALOG_INPUT_INVALID");
      action = raw.action;
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    let latest = parseCatalogInstant(clock()),
      failed = false;
    const observedAt = latest,
      validUntil = new Date(Date.parse(latest) + 5000).toISOString();
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (failed || at < latest || at >= validUntil) {
          failed = true;
          return fail();
        }
        latest = at;
        return at;
      } catch {
        failed = true;
        return fail();
      }
    };
    const session = await authenticate({ sessionCookie, csrf }).catch((error: unknown) =>
      fail(
        error instanceof BrowserSessionError
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      ),
    );
    now();
    let calls = 0,
      completed: MerchantProductAuthoringContext | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) {
        failed = true;
        return fail();
      }
      const query = tx.query;
      let ready = false,
        rehold: (() => Promise<void>) | undefined,
        assertCurrent: (() => void) | undefined;
      const check = () => {
        now();
        if (tx.query !== query) {
          failed = true;
          return fail();
        }
        assertCurrent?.();
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || !rehold) return fail();
          await rehold();
          check();
        },
        () => {
          if (!ready) return fail();
          check();
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
          tenantReference = parseCatalogReference(scope.tenantReference),
          actorReference = parseCatalogReference(scope.actorReference),
          capabilityKey =
            action === "Create" ? "catalog.cat_product_create" : "catalog.cat_product_edit",
          current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: validUntil,
            capabilityKey,
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference,
            brandReference: selected.brandReference,
            storeReference: selected.storeReference,
            actorReference,
            clock: { now },
            originalValidUntil: validUntil,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey,
          });
        assertCurrent = current.assertCurrent;
        rehold = async () => {
          check();
          await capability.holdUntilCommit();
          check();
          await current.authorizeActions([
            "catalog.manage",
            "catalog.product.manage",
            "catalog.product.read",
            "catalog.product.history.read",
          ]);
          check();
        };
        await rehold();
        completed = Object.freeze({
          profile: "CatalogProductAuthoringContextV1",
          action,
          tenantReference,
          actorReference,
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          observedAt,
          validUntil,
        });
        ready = true;
        return completed;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (!completed || result !== completed || calls !== 1) return fail();
    now();
    return completed;
  };
}
