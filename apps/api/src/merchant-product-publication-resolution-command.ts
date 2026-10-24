import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductPublicationResolutionStore,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogProductPublicationResolutionCommand,
  parseCatalogProductPublicationResolution,
  productPublicationResolutionFields,
  type ProductPublicationResolutionStoreOptions,
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

type StoreOptions = ProductPublicationResolutionStoreOptions;
type AuthorityInput = Parameters<StoreOptions["authority"]["holdUntilTransactionCompletes"]>[1];
type Transaction = Parameters<StoreOptions["authority"]["holdUntilTransactionCompletes"]>[0];
const publicationFields = [
  "operationReference",
  "productReference",
  "versionReference",
  "expectedProductAggregateVersion",
  "expectedPublicationVersion",
  "action",
  "contentDigest",
  "configurationDigest",
  "scopeSet",
  "effectivePeriod",
  "scheduleReference",
  "replacementVersionReference",
  "successorDraftVersionReference",
  "occurredAt",
  "reasonCode",
] as const;
const acknowledgementFields = [
  "profile",
  "action",
  "operationReference",
  "productReference",
  "versionReference",
  "expectedProductAggregateVersion",
  "reportOperationReference",
  "reportDigest",
  "warningBindingDigest",
  "warningCodes",
  "reasonCode",
  "occurredAt",
] as const;
const permissions = Object.freeze([
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.read",
  "catalog.product.history.read",
] as const);
const purposeCode = "CATALOG_PRODUCT_PUBLICATION_OPERATION_RESOLUTION" as const;
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const same = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
export interface MerchantProductPublicationResolutionResult {
  readonly profile: "CatalogProductPublicationResolutionResultV1";
  readonly outcome: "Committed" | "Abandoned";
  readonly originalKind: "PublicationV1" | "PublicationV2" | "WarningAcknowledgementV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly operationReference: string;
  readonly originalCommandDigest: string;
  readonly originalIntentDigest: string;
  readonly recordedAt: string;
  readonly resolutionDigest: string;
  readonly currentAggregateVersion: number;
}
export interface MerchantProductPublicationResolutionOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly auditReference: (operationReference: string) => string;
  readonly currentRuntime?: true;
  readonly authority?: StoreOptions["authority"];
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
      readonly operationReference: string;
      readonly screenId: "CAT-PRODUCT-EDIT";
      readonly capability: "catalog.cat_product_edit";
      readonly permission: "catalog.manage";
      readonly owningAction: "catalog.product.manage";
      readonly purposeCode: typeof purposeCode;
      readonly requiredFields: typeof productPublicationResolutionFields;
      readonly observedAt: string;
    },
  ) => Promise<void>;
}

/** Resolve an exact original transport intent under current management authority.
 * This entry never executes the original command or acquires its qualification. */
export function createMerchantProductPublicationResolutionCommand(
  options: MerchantProductPublicationResolutionOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    (options.currentRuntime !== undefined && options.currentRuntime !== true) ||
    (options.currentRuntime === true &&
      (options.authority !== undefined || options.holdScreenUntilCommit !== undefined)) ||
    (options.currentRuntime !== true &&
      (typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
        typeof options.holdScreenUntilCommit !== "function")) ||
    typeof options.auditReference !== "function"
  )
    return fail();
  const run = options.merchant.transactions.run.bind(options.merchant.transactions),
    clock = options.merchant.now.bind(options.merchant),
    authenticate = options.authentication.authorize.bind(options.authentication),
    hold = options.authority?.holdUntilTransactionCompletes.bind(options.authority),
    screen = options.holdScreenUntilCommit?.bind(options),
    currentRuntime = options.currentRuntime === true,
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
  }) => {
    const sessionCookie = request.sessionCookie,
      csrf = request.csrf,
      expected = parseMerchantProductCommandScope(request.expectedScope);
    let raw: Record<string, unknown>, original: Record<string, unknown>, fields: readonly string[];
    try {
      raw = readClosedRecord(copyCategoryPersistenceValue(request.command), [
        "profile",
        "originalKind",
        "originalCommand",
      ]);
      if (
        raw.profile !== "CatalogProductPublicationResolutionCommandV1" ||
        !["PublicationV1", "PublicationV2", "WarningAcknowledgementV1"].includes(
          typeof raw.originalKind === "string" ? raw.originalKind : "",
        )
      )
        return fail("CATALOG_INPUT_INVALID");
      fields =
        raw.originalKind === "WarningAcknowledgementV1"
          ? acknowledgementFields
          : raw.originalKind === "PublicationV2"
            ? [...publicationFields, "profile", "replacementIntent", "replacementIntentDigest"]
            : publicationFields;
      original = readClosedRecord(raw.originalCommand, fields);
      if (original.action === "ActivateScheduled" || original.action === "Supersede")
        return fail("CATALOG_PERMISSION_DENIED");
      if (Buffer.byteLength(canonicalizeRfc8785(original), "utf8") > 8192)
        return fail("CATALOG_INPUT_INVALID");
    } catch (error) {
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail("CATALOG_INPUT_INVALID");
    }
    const session = await authenticate({
      sessionCookie,
      csrf,
    }).catch((error: unknown) =>
      fail(
        error instanceof BrowserSessionError
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      ),
    );
    let failed = false,
      latest: string;
    try {
      latest = parseCatalogInstant(clock());
    } catch {
      return fail();
    }
    const originalObservedAt = latest,
      validUntil = new Date(Date.parse(latest) + 5000).toISOString();
    const reject = (): never => {
      failed = true;
      return fail();
    };
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (failed || at < latest || at >= validUntil) return reject();
        latest = at;
        return at;
      } catch {
        return reject();
      }
    };
    let calls = 0,
      completed: { readonly result: MerchantProductPublicationResolutionResult } | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return reject();
      const query = tx.query;
      let assertAuthorization: (() => void) | undefined;
      const check = () => {
        now();
        if (tx.query !== query) return reject();
        assertAuthorization?.();
      };
      // Register before scope/store work: caught malformed packets and callbacks
      // cannot leave a borrowed transaction eligible to commit.
      let lastInput: AuthorityInput | undefined,
        ready = false;
      let recheck: (() => Promise<void>) | undefined;
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || !lastInput || !recheck) return reject();
          await recheck();
          check();
        },
        () => {
          if (!ready) return reject();
          check();
        },
      );
      try {
        check();
        const scope = await resolve(tx, sessionCookie, session.sessionReference);
        check();
        bindMerchantProductCommandScope(
          {
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.selectedStoreReference,
          },
          expected,
        );
        const command = parseCatalogProductPublicationResolutionCommand({
            ...raw,
            originalCommand: {
              ...original,
              purposeCode:
                raw.originalKind === "WarningAcknowledgementV1"
                  ? "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT"
                  : "CATALOG_PRODUCT_VERSION_PUBLICATION",
              tenantReference: scope.tenantReference,
              brandReference: scope.context.brand.brandReference,
              actorReference: scope.actorReference,
              actorKind: "User",
            },
          }),
          c = command.originalCommand,
          originalIntentDigest = hash(c),
          originalCommandDigest = hash(
            Object.fromEntries(
              fields.map((key) => [key, (c as unknown as Record<string, unknown>)[key]]),
            ),
          ),
          authorize = scope.authorizeAction.bind(scope),
          currentAuthorization = currentRuntime
            ? createMerchantProductCurrentAuthorization({
                merchant,
                transaction: tx,
                scope,
                sessionCookie,
                sessionReference: session.sessionReference,
                clock: { now },
                originalValidUntil: validUntil,
              })
            : undefined,
          capability = currentAuthorization
            ? createMerchantProductStoreCapabilityGuard({
                transaction: tx,
                tenantReference: c.tenantReference,
                brandReference: c.brandReference,
                storeReference: scope.selectedStoreReference,
                actorReference: c.actorReference,
                clock: { now },
                originalValidUntil: validUntil,
                registerBeforeCommit: host.registerBeforeCommit,
                currentAuthorization,
              })
            : undefined;
        assertAuthorization = currentAuthorization?.assertCurrent;
        const admit = async () => {
          if (currentAuthorization && capability) {
            check();
            await capability.holdUntilCommit();
            check();
            // Feature evaluation borrows Store scope. The actual final Brand
            // permission read restores Brand RLS before the owning fence/Audit
            // write; no transport SQL or original-action qualification is used.
            await currentAuthorization.authorizeActions(permissions);
            check();
            return;
          }
          if (!screen) return reject();
          for (const action of permissions) {
            check();
            const decision = await authorize(action);
            check();
            if (
              decision?.effect !== "Allow" ||
              decision.action !== action ||
              decision.scopeKind !== "Brand"
            ) {
              failed = true;
              return fail("CATALOG_PERMISSION_DENIED");
            }
          }
          if (
            (await screen(tx, {
              tenantReference: c.tenantReference,
              brandReference: c.brandReference,
              storeReference: scope.selectedStoreReference,
              actorReference: c.actorReference,
              sessionReference: session.sessionReference,
              productReference: c.productReference,
              versionReference: c.versionReference,
              operationReference: c.operationReference,
              screenId: "CAT-PRODUCT-EDIT",
              capability: "catalog.cat_product_edit",
              permission: "catalog.manage",
              owningAction: "catalog.product.manage",
              purposeCode,
              requiredFields: productPublicationResolutionFields,
              observedAt: now(),
            })) !== undefined
          )
            return reject();
          check();
        };
        const current = async (value: AuthorityInput) => {
          try {
            check();
            const r = readClosedRecord(copyCategoryPersistenceValue(value), [
              "tenantReference",
              "brandReference",
              "actorReference",
              "actorKind",
              "command",
              "purposeCode",
              "permission",
              "requiredPermissions",
              "requiredScope",
              "requiredFields",
              "observedAt",
            ]);
            if (
              r.tenantReference !== c.tenantReference ||
              r.brandReference !== c.brandReference ||
              r.actorReference !== c.actorReference ||
              r.actorKind !== "User" ||
              !same(parseCatalogProductPublicationResolutionCommand(r.command), command) ||
              r.purposeCode !== purposeCode ||
              r.permission !== "catalog.manage" ||
              r.requiredScope !== "FullBrandScope" ||
              !same(r.requiredPermissions, permissions) ||
              !same(r.requiredFields, productPublicationResolutionFields)
            )
              return reject();
            const observedAt = parseCatalogInstant(r.observedAt);
            if (observedAt < originalObservedAt || observedAt > now()) return reject();
            const packet: AuthorityInput = Object.freeze({
              tenantReference: c.tenantReference,
              brandReference: c.brandReference,
              actorReference: c.actorReference,
              actorKind: "User",
              command,
              purposeCode,
              permission: "catalog.manage",
              requiredPermissions: permissions,
              requiredScope: "FullBrandScope",
              requiredFields: productPublicationResolutionFields,
              observedAt,
            });
            await admit();
            if (hold) {
              if ((await hold(tx, packet)) !== undefined) return reject();
              check();
              await admit();
            }
            lastInput = packet;
          } catch (error) {
            failed = true;
            if (
              error instanceof MerchantProductWriteFeatureDisabled ||
              (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
            )
              throw error;
            return reject();
          }
        };
        recheck = async () => {
          if (!lastInput) return reject();
          await current(lastInput);
        };
        let storeCalls = 0;
        const store = createPostgresProductPublicationResolutionStore({
          tenantReference: c.tenantReference,
          brandReference: c.brandReference,
          actorReference: c.actorReference,
          clock: { now },
          transactions: {
            run: async (work) => {
              if (++storeCalls !== 1) return reject();
              check();
              const value = await work(tx);
              check();
              return value;
            },
          },
          async registerBeforeCommit(actual, guard, finalAssert) {
            if (actual !== tx || typeof guard !== "function" || typeof finalAssert !== "function")
              return reject();
            await host.registerBeforeCommit(actual, guard, finalAssert);
            check();
          },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (actual !== tx) return reject();
              await current(input);
            },
          },
          audit: {
            create({ resolution }) {
              return {
                auditId: parseCatalogReference(auditReference(c.operationReference)),
                brandId: c.brandReference,
                actor: { type: "User", reference: c.actorReference },
                actionCode: "CATALOG_PRODUCT_PUBLICATION_OPERATION_ABANDONED",
                targetType: "ProductPublicationOperation",
                targetId: c.operationReference,
                reasonCode: "ORIGINAL_OPERATION_ABANDONED",
                correlationId: c.operationReference,
                occurredAt: resolution.recordedAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              };
            },
          },
        });
        const rawResult = readClosedRecord(await store.execute(command), [
            "resolution",
            "currentAggregateVersion",
          ]),
          currentAggregateVersion = rawResult.currentAggregateVersion;
        let resolution: ReturnType<typeof parseCatalogProductPublicationResolution>;
        try {
          resolution = parseCatalogProductPublicationResolution(rawResult.resolution);
        } catch {
          return reject();
        }
        check();
        if (
          storeCalls !== 1 ||
          !lastInput ||
          resolution.originalKind !== command.originalKind ||
          resolution.originalIntentDigest !== originalIntentDigest ||
          resolution.tenantReference !== c.tenantReference ||
          resolution.brandReference !== c.brandReference ||
          resolution.actorReference !== c.actorReference ||
          resolution.productReference !== c.productReference ||
          resolution.versionReference !== c.versionReference ||
          resolution.operationReference !== c.operationReference ||
          resolution.recordedAt > now() ||
          typeof currentAggregateVersion !== "number" ||
          !Number.isSafeInteger(currentAggregateVersion) ||
          currentAggregateVersion < 1 ||
          currentAggregateVersion > 2147483647
        )
          return reject();
        const value = Object.freeze({
          profile: "CatalogProductPublicationResolutionResultV1" as const,
          outcome: resolution.outcome,
          originalKind: resolution.originalKind,
          tenantReference: c.tenantReference,
          brandReference: c.brandReference,
          storeReference: scope.selectedStoreReference,
          productReference: c.productReference,
          versionReference: c.versionReference,
          operationReference: c.operationReference,
          originalCommandDigest,
          originalIntentDigest,
          recordedAt: resolution.recordedAt,
          resolutionDigest: resolution.digest,
          currentAggregateVersion,
        });
        ready = true;
        completed = { result: value };
        return completed;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    });
    if (calls !== 1 || !completed || result !== completed) return reject();
    now();
    return result.result;
  };
}
