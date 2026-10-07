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
export interface MerchantOptionSetAuthoringContextOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
}
export interface MerchantOptionSetAuthoringContext {
  readonly profile: "CatalogOptionSetAuthoringContextV1";
  readonly action: "Create" | "Edit";
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
/** Read-only current identity for recovery. Actual Create/Edit Feature admission
 * is independent from write permission; no mutation or content qualification is authorized. */
export function createMerchantOptionSetAuthoringContextQuery(
  options: MerchantOptionSetAuthoringContextOptions,
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
  }): Promise<MerchantOptionSetAuthoringContext> => {
    const sessionCookie = request.sessionCookie,
      csrf = request.csrf,
      expected = parseMerchantProductCommandScope(request.expectedScope);
    let action: "Create" | "Edit";
    try {
      const raw = readClosedRecord(copyCategoryPersistenceValue(request.command), ["action"]);
      if (raw.action !== "Create" && raw.action !== "Edit") return fail("CATALOG_INPUT_INVALID");
      action = raw.action;
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    let latest = parseCatalogInstant(clock()),
      failed = false;
    const observedAt = latest,
      originalDeadline = new Date(Date.parse(latest) + 5000).toISOString();
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
    const session = await authenticate({ sessionCookie, csrf }).catch((error: unknown) =>
      fail(
        error instanceof BrowserSessionError
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      ),
    );
    now();
    let calls = 0,
      finalized = false,
      completed: Omit<MerchantOptionSetAuthoringContext, "profile" | "validUntil"> | undefined,
      assertSources: (() => void) | undefined;
    const value = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return poison();
      const query = tx.query;
      let ready = false,
        active = false,
        guardCalls = 0,
        guardComplete = false,
        finalCalls = 0,
        rehold: (() => Promise<void>) | undefined;
      const check = () => {
        now();
        if (tx.query !== query) return poison();
        assertSources?.();
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || active || !rehold || ++guardCalls !== 1) return poison();
          await rehold();
          check();
          guardComplete = true;
        },
        () => {
          if (!ready || active || !guardComplete || guardCalls !== 1 || ++finalCalls !== 1)
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
          tenantReference = parseCatalogReference(scope.tenantReference),
          actorReference = parseCatalogReference(scope.actorReference),
          capabilityKey =
            action === "Create" ? "catalog.cat_optionset_create" : "catalog.cat_optionset_edit",
          current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            capabilityKey,
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference,
            brandReference: selected.brandReference,
            storeReference: selected.storeReference,
            actorReference,
            clock: { now },
            originalValidUntil: originalDeadline,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey,
          });
        if (
          typeof current.leaseDeadline !== "function" ||
          typeof capability.leaseDeadline !== "function"
        )
          return poison();
        const assert = current.assertCurrent.bind(current),
          authorize = current.authorizeActions.bind(current),
          hold = capability.holdUntilCommit.bind(capability),
          currentLease = current.leaseDeadline.bind(current),
          capabilityLease = capability.leaseDeadline.bind(capability);
        let admitted = false;
        assertSources = () => {
          try {
            parseCatalogInstant(assert());
            if (admitted) {
              const a = parseCatalogInstant(currentLease()),
                b = parseCatalogInstant(capabilityLease());
              if (a < deadline) deadline = a;
              if (b < deadline) deadline = b;
              now();
            }
          } catch (error) {
            failed = true;
            if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
              throw error;
            return fail();
          }
        };
        rehold = async () => {
          if (active) return poison();
          active = true;
          try {
            check();
            if ((await hold()) !== undefined) return poison();
            admitted = true;
            check();
            if (
              (await authorize(Object.freeze(["catalog.manage", "catalog.option_set.read"]))) !==
              undefined
            )
              return poison();
            check();
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            active = false;
          }
        };
        await rehold();
        check();
        completed = Object.freeze({
          action,
          tenantReference,
          actorReference,
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          observedAt,
        });
        ready = true;
        return completed;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (calls !== 1 || !finalized || !completed || value !== completed || !assertSources)
      return poison();
    // Observe the captured actual source deadlines again after the COMMIT owner
    // returns; this is not another final assertion and cannot renew either lease.
    try {
      now();
      assertSources();
      now();
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
    return Object.freeze({
      profile: "CatalogOptionSetAuthoringContextV1",
      ...completed,
      validUntil: deadline,
    });
  };
}
