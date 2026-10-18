import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  createPostgresProductAuthoringResolutionStore,
  parseCatalogProductAuthoringResolutionCommand,
  parseCatalogProductAuthoringResolution,
  productAuthoringResolutionFields,
  type CatalogProductAuthoringResolution,
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

const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
export interface MerchantProductAuthoringResolutionOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly auditReference: (operationReference: string) => string;
}
export interface MerchantProductAuthoringResolutionResult {
  readonly profile: "CatalogProductAuthoringResolutionResultV1";
  readonly storeReference: string;
  readonly resolution: CatalogProductAuthoringResolution;
}
/** Actual current Session/Brand/Store admission. No original content requalification
 * and no new execution. The Catalog owner resolves or permanently fences absence. */
export function createMerchantProductAuthoringResolutionCommand(
  options: MerchantProductAuthoringResolutionOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    typeof options.auditReference !== "function"
  )
    return fail();
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication),
    auditReference = options.auditReference.bind(options),
    merchant = Object.freeze({
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
    readonly command: unknown;
    readonly expectedScope: unknown;
  }): Promise<MerchantProductAuthoringResolutionResult> => {
    const expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let raw: Record<string, unknown>;
    try {
      raw = readClosedRecord(copyCategoryPersistenceValue(request.command), [
        "profile",
        "tenantReference",
        "action",
        "operationReference",
        "productReference",
        "expectedAggregateVersion",
      ]);
      if (raw.profile !== "CatalogProductAuthoringResolutionRequestV1")
        return fail("CATALOG_INPUT_INVALID");
      parseCatalogReference(raw.tenantReference);
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    let latest = parseCatalogInstant(clock()),
      failed = false;
    const startedAt = latest,
      deadline = new Date(Date.parse(latest) + 5000).toISOString();
    const reject = (): never => {
      failed = true;
      return fail();
    };
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (failed || at < latest || at >= deadline) return reject();
        latest = at;
        return at;
      } catch {
        return reject();
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
      completed: MerchantProductAuthoringResolutionResult | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return reject();
      const query = tx.query;
      let ready = false,
        holdAgain: (() => Promise<void>) | undefined,
        assertCurrent: (() => void) | undefined;
      const check = () => {
        now();
        if (tx.query !== query) return reject();
        assertCurrent?.();
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || !holdAgain) return reject();
          await holdAgain();
          check();
        },
        () => {
          if (!ready) return reject();
          check();
        },
      );
      try {
        const scope = await resolve(tx, sessionCookie, session.sessionReference);
        check();
        const bound = bindMerchantProductCommandScope(
          {
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.selectedStoreReference,
          },
          expected,
        );
        if (scope.tenantReference !== raw.tenantReference) return fail("CATALOG_PERMISSION_DENIED");
        const command = parseCatalogProductAuthoringResolutionCommand({
          profile: "CatalogProductAuthoringResolutionCommandV1",
          tenantReference: scope.tenantReference,
          brandReference: bound.brandReference,
          actorReference: scope.actorReference,
          action: raw.action,
          operationReference: raw.operationReference,
          productReference: raw.productReference,
          expectedAggregateVersion: raw.expectedAggregateVersion,
        });
        const capabilityKey =
            command.action === "Create" ? "catalog.cat_product_create" : "catalog.cat_product_edit",
          permissions = Object.freeze([
            "catalog.manage",
            "catalog.product.manage",
            "catalog.product.read",
            "catalog.product.history.read",
          ] as const),
          current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: deadline,
            capabilityKey,
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference: command.tenantReference,
            brandReference: command.brandReference,
            storeReference: bound.storeReference,
            actorReference: command.actorReference,
            clock: { now },
            originalValidUntil: deadline,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey,
          });
        assertCurrent = current.assertCurrent;
        holdAgain = async () => {
          check();
          await capability.holdUntilCommit();
          check();
          await current.authorizeActions(permissions);
          check();
        };
        let sourceCalls = 0;
        const store = createPostgresProductAuthoringResolutionStore({
          tenantReference: command.tenantReference,
          brandReference: command.brandReference,
          actorReference: command.actorReference,
          clock: { now },
          transactions: {
            async run(work) {
              if (++sourceCalls !== 1) return reject();
              check();
              const value = await work(tx);
              check();
              return value;
            },
          },
          async registerBeforeCommit(actual, guard, finalAssert) {
            if (actual !== tx) return reject();
            await host.registerBeforeCommit(actual, guard, finalAssert);
            check();
          },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (
                actual !== tx ||
                canonicalizeRfc8785(input.command) !== canonicalizeRfc8785(command) ||
                input.actorKind !== "User" ||
                input.purposeCode !== "CATALOG_PRODUCT_AUTHORING_OPERATION_RESOLUTION" ||
                input.permission !== "catalog.manage" ||
                input.requiredScope !== "FullBrandScope" ||
                canonicalizeRfc8785(input.requiredPermissions) !==
                  canonicalizeRfc8785(permissions) ||
                canonicalizeRfc8785(input.requiredFields) !==
                  canonicalizeRfc8785(productAuthoringResolutionFields) ||
                parseCatalogInstant(input.observedAt) < startedAt ||
                input.observedAt > now()
              )
                return reject();
              if (!holdAgain) return reject();
              await holdAgain();
            },
          },
          audit: {
            create({ resolution }) {
              return {
                auditId: parseCatalogReference(auditReference(command.operationReference)),
                brandId: command.brandReference,
                actor: { type: "User", reference: command.actorReference },
                actionCode: "CATALOG_PRODUCT_AUTHORING_OPERATION_ABANDONED",
                targetType: "ProductAuthoringOperation",
                targetId: command.operationReference,
                reasonCode: "ORIGINAL_OPERATION_ABANDONED",
                correlationId: command.operationReference,
                occurredAt: resolution.recordedAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              };
            },
          },
        });
        const resolution = parseCatalogProductAuthoringResolution(await store.execute(command));
        check();
        if (
          sourceCalls !== 1 ||
          canonicalizeRfc8785(resolution.command) !== canonicalizeRfc8785(command) ||
          resolution.recordedAt > now()
        )
          return reject();
        ready = true;
        completed = Object.freeze({
          profile: "CatalogProductAuthoringResolutionResultV1",
          storeReference: bound.storeReference,
          resolution,
        });
        return completed;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (calls !== 1 || !completed || result !== completed) return reject();
    now();
    return result;
  };
}
