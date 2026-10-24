import { createPostgresTransactionCurrentPermissionPolicySource } from "@bop/permission";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseCatalogProductPublicationWarningAcknowledgementObservation,
  parseCatalogProductPublicationWarningAcknowledgementReceipt,
  createPostgresProductPublicationWarningAcknowledgementStore,
  productPublicationWarningAcknowledgementFields,
  type ProductPublicationWarningAcknowledgementStoreOptions,
} from "@rms/catalog";
import {
  createMerchantProductCategoryAssignments,
  type MerchantProductCategoryPolicy,
} from "./merchant-product-category-assignments.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

import {
  createMerchantProductStoreCapabilityGuard,
  type MerchantProductStoreCapabilityGuard,
} from "./merchant-product-store-capability.js";
import { createMerchantProductPublicationRuntimeAuthority } from "./merchant-product-publication-runtime-authority.js";

type StoreOptions = ProductPublicationWarningAcknowledgementStoreOptions;
type AuthorityInput = Parameters<StoreOptions["authority"]["holdUntilTransactionCompletes"]>[1];
type Transaction = Parameters<StoreOptions["authority"]["holdUntilTransactionCompletes"]>[0];
const fields = [
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
  "catalog.product.acknowledge-warnings",
  "catalog.product.read",
  "catalog.product.history.read",
] as const);
const purposeCode = "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT" as const;
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
export interface MerchantProductWarningAcknowledgementSourceFactoryInput {
  readonly transaction: Transaction;
  readonly command: AuthorityInput["command"];
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly storeReference: string;
  readonly sessionReference: string;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  /** Actual current Brand-scoped User permission in this same outer transaction. */
  readonly authorizeMediaAccess: () => Promise<void>;
  readonly currentAuthorization?: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  /** Concrete same-request Screen authority; absent only for legacy composition. */
  readonly capability?: MerchantProductStoreCapabilityGuard;
  readonly registerBeforeCommit: StoreOptions["registerBeforeCommit"];
}
export type MerchantProductWarningAcknowledgementSourceFactory = (
  input: MerchantProductWarningAcknowledgementSourceFactoryInput,
) => { readonly sources: StoreOptions["sources"] };
export interface MerchantProductPublicationWarningAcknowledgementOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly auditReference: (operationReference: string) => string;
  readonly authority?: StoreOptions["authority"];
  readonly sources?: StoreOptions["sources"];
  /** Captures actual-transaction ports only. Fresh reads happen exclusively in
   * withHeldCurrentObservation; original replay never asks for new qualification. */
  readonly sourceFactory?: MerchantProductWarningAcknowledgementSourceFactory;
  readonly contentAuthority?: StoreOptions["contentAuthority"];
  readonly historyAuthority?: StoreOptions["historyAuthority"];
  readonly reportAuthority?: StoreOptions["reportAuthority"];
  readonly categoryPolicy?: MerchantProductCategoryPolicy;
  readonly currentRuntime?: true;
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
      readonly owningAction: "catalog.product.acknowledge-warnings";
      readonly purposeCode: typeof purposeCode;
      readonly requiredFields: typeof productPublicationWarningAcknowledgementFields;
      readonly observedAt: string;
    },
  ) => Promise<void>;
}
/** Independent consent transport. Actual Ack-specific observation and policy are
 * supplied by an owning held producer; no publication command is synthesized. */
export function createMerchantProductPublicationWarningAcknowledgementCommand(
  options: MerchantProductPublicationWarningAcknowledgementOptions,
) {
  const authenticate = options.authentication?.authorize?.bind(options.authentication),
    run = options.merchant?.transactions?.run?.bind(options.merchant.transactions),
    clock = options.merchant?.now?.bind(options.merchant),
    suppliedHold = options.authority?.holdUntilTransactionCompletes?.bind(options.authority),
    suppliedObserve = options.sources?.withHeldCurrentObservation?.bind(options.sources),
    sourceFactory =
      typeof options.sourceFactory === "function" ? options.sourceFactory.bind(options) : undefined,
    suppliedContentHold = options.contentAuthority?.holdUntilTransactionCompletes?.bind(
      options.contentAuthority,
    ),
    suppliedHistoryHold = options.historyAuthority?.holdUntilTransactionCompletes?.bind(
      options.historyAuthority,
    ),
    suppliedReportHold = options.reportAuthority?.holdUntilTransactionCompletes?.bind(
      options.reportAuthority,
    ),
    categoryPolicy = options.categoryPolicy,
    suppliedScreen =
      typeof options.holdScreenUntilCommit === "function"
        ? options.holdScreenUntilCommit.bind(options)
        : undefined,
    currentRuntime = options.currentRuntime === true,
    auditReference = options.auditReference?.bind(options);
  if (
    !authenticate ||
    !run ||
    !clock ||
    (options.currentRuntime !== undefined && options.currentRuntime !== true) ||
    (currentRuntime
      ? options.authority !== undefined ||
        options.contentAuthority !== undefined ||
        options.historyAuthority !== undefined ||
        options.reportAuthority !== undefined ||
        options.holdScreenUntilCommit !== undefined ||
        !sourceFactory
      : !suppliedHold ||
        !suppliedContentHold ||
        !suppliedHistoryHold ||
        !suppliedReportHold ||
        !suppliedScreen) ||
    (options.sourceFactory === undefined
      ? !suppliedObserve
      : typeof options.sourceFactory !== "function" || options.sources !== undefined) ||
    !auditReference
  )
    return fail();
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
  });
  const resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions({ run });
  return async (request: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly command: unknown;
    readonly expectedScope: unknown;
  }) => {
    const expected = parseMerchantProductCommandScope(request.expectedScope);
    let raw: Record<string, unknown>;
    try {
      raw = readClosedRecord(copyCategoryPersistenceValue(request.command), fields);
      if (
        raw.profile !== "CatalogProductPublicationWarningAcknowledgementCommandV1" ||
        raw.action !== "AcknowledgeProductPublicationWarnings"
      )
        return fail("CATALOG_INPUT_INVALID");
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    const session = await authenticate({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    }).catch((error: unknown) => {
      return fail(
        error instanceof BrowserSessionError
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
    });
    let failed = false,
      latest = parseCatalogInstant(clock()),
      validUntil = new Date(Date.parse(latest) + 5000).toISOString(),
      transactionCalls = 0;
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
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    const protect = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    let completed: { readonly result: unknown } | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++transactionCalls !== 1) return reject();
      now();
      const permissionPolicy = currentRuntime
        ? createPostgresTransactionCurrentPermissionPolicySource(tx)
        : undefined;
      if (
        currentRuntime &&
        (!permissionPolicy ||
          typeof permissionPolicy.authorize !== "function" ||
          typeof permissionPolicy.authorizeWithRoles !== "function" ||
          typeof permissionPolicy.authorizeActionsWithRoles !== "function")
      )
        return fail();
      const scope = await (
        permissionPolicy === undefined
          ? resolve
          : createMerchantBrandScope(merchant, permissionPolicy)
      )(tx, request.sessionCookie, session.sessionReference);
      now();
      bindMerchantProductCommandScope(
        {
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.selectedStoreReference,
        },
        expected,
      );
      const command = parseCatalogProductPublicationWarningAcknowledgementCommand({
          ...raw,
          purposeCode,
          tenantReference: scope.tenantReference,
          brandReference: scope.context.brand.brandReference,
          actorReference: scope.actorReference,
          actorKind: "User",
        }),
        commandHash = "sha256:" + sha256Hex(canonicalizeRfc8785(command)),
        authorize = scope.authorizeAction.bind(scope),
        query = tx.query;
      const currentAuthorization = createMerchantProductCurrentAuthorization({
        merchant: merchant,
        transaction: tx,
        scope,
        sessionCookie: request.sessionCookie,
        sessionReference: session.sessionReference,
        clock: { now: now },
        originalValidUntil: validUntil,
        ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
      });
      const factoryHostBase = Object.freeze({
        transaction: tx,
        command,
        tenantReference: command.tenantReference,
        brandReference: command.brandReference,
        actorReference: command.actorReference,
        storeReference: scope.selectedStoreReference,
        sessionReference: session.sessionReference,
        clock: Object.freeze({ now }),
        originalValidUntil: validUntil,
        currentAuthorization,
        async authorizeMediaAccess() {
          try {
            now();
            if (currentRuntime) {
              await currentAuthorization.authorizeActions(["media.asset.access"]);
              currentAuthorization.assertCurrent();
              now();
              return;
            }
            const decision = await authorize("media.asset.access");
            now();
            if (
              decision?.effect !== "Allow" ||
              decision.action !== "media.asset.access" ||
              decision.scopeKind !== "Brand"
            )
              return fail("CATALOG_PERMISSION_DENIED");
          } catch (error) {
            failed = true;
            throw error;
          }
        },
        async registerBeforeCommit(actual, guard, finalAssert) {
          if (actual !== tx || typeof guard !== "function" || typeof finalAssert !== "function")
            return reject();
          await host.registerBeforeCommit(actual, guard, finalAssert);
        },
      } satisfies MerchantProductWarningAcknowledgementSourceFactoryInput);
      const capability = currentRuntime
          ? createMerchantProductStoreCapabilityGuard(factoryHostBase)
          : undefined,
        factoryHost = Object.freeze({
          ...factoryHostBase,
          ...(capability === undefined ? {} : { capability }),
        });
      if (currentRuntime && typeof capability?.holdUntilCommit !== "function") return fail();
      const created = sourceFactory?.(factoryHost),
        runtimeAuthority = currentRuntime
          ? createMerchantProductPublicationRuntimeAuthority(factoryHost)
          : undefined,
        hold =
          runtimeAuthority?.acknowledgementAuthority.holdUntilTransactionCompletes.bind(
            runtimeAuthority.acknowledgementAuthority,
          ) ??
          suppliedHold ??
          reject(),
        contentHold =
          runtimeAuthority?.acknowledgementContentAuthority.holdUntilTransactionCompletes.bind(
            runtimeAuthority.acknowledgementContentAuthority,
          ) ??
          suppliedContentHold ??
          reject(),
        historyHold =
          runtimeAuthority?.acknowledgementHistoryAuthority.holdUntilTransactionCompletes.bind(
            runtimeAuthority.acknowledgementHistoryAuthority,
          ) ??
          suppliedHistoryHold ??
          reject(),
        reportHold =
          runtimeAuthority?.acknowledgementReportAuthority.holdUntilTransactionCompletes.bind(
            runtimeAuthority.acknowledgementReportAuthority,
          ) ??
          suppliedReportHold ??
          reject();
      if (sourceFactory !== undefined) {
        readClosedRecord(created, ["sources"]);
        if (typeof created?.sources?.withHeldCurrentObservation !== "function") return reject();
      }
      const observe =
        created === undefined
          ? (suppliedObserve ?? reject())
          : created.sources.withHeldCurrentObservation.bind(created.sources);
      now();
      let lastInput: AuthorityInput | undefined,
        sourceCalls = 0;
      const check = () => {
        currentAuthorization.assertCurrent();
        now();
        if (tx.query !== query) return reject();
      };
      const admit = async () => {
        if (currentRuntime) {
          check();
          await currentAuthorization.authorizeActions([...new Set(permissions)]);
          check();
        } else {
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
        }
        if (capability) {
          await capability.holdUntilCommit();
        } else if (
          (await (suppliedScreen ?? reject())(tx, {
            tenantReference: command.tenantReference,
            brandReference: command.brandReference,
            storeReference: scope.selectedStoreReference,
            actorReference: command.actorReference,
            sessionReference: session.sessionReference,
            productReference: command.productReference,
            versionReference: command.versionReference,
            operationReference: command.operationReference,
            screenId: "CAT-PRODUCT-EDIT",
            capability: "catalog.cat_product_edit",
            permission: "catalog.manage",
            owningAction: "catalog.product.acknowledge-warnings",
            purposeCode,
            requiredFields: productPublicationWarningAcknowledgementFields,
            observedAt: now(),
          })) !== undefined
        )
          return reject();
        check();
      };
      const current = (value: AuthorityInput) =>
        protect(async () => {
          check();
          const r = readClosedRecord(copyCategoryPersistenceValue(value), [
            "command",
            "mode",
            "purposeCode",
            "permission",
            "requiredPermissions",
            "requiredScope",
            "requiredFields",
            "observedAt",
          ]);
          if (
            !same(
              parseCatalogProductPublicationWarningAcknowledgementCommand(r.command),
              command,
            ) ||
            !["Acknowledge", "Replay"].includes(String(r.mode)) ||
            r.purposeCode !== purposeCode ||
            r.permission !== "catalog.manage" ||
            !same(r.requiredPermissions, permissions) ||
            r.requiredScope !== "FullBrandScope" ||
            !same(r.requiredFields, productPublicationWarningAcknowledgementFields)
          )
            return reject();
          const observedAt = parseCatalogInstant(r.observedAt);
          if (observedAt > now()) return reject();
          const packet: AuthorityInput = Object.freeze({
            command,
            mode: r.mode as AuthorityInput["mode"],
            purposeCode,
            permission: "catalog.manage",
            requiredPermissions: permissions,
            requiredScope: "FullBrandScope",
            requiredFields: productPublicationWarningAcknowledgementFields,
            observedAt,
          });
          await admit();
          if ((await hold(tx, packet)) !== undefined) return reject();
          check();
          await admit();
          lastInput = packet;
        });
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!lastInput) return reject();
          await current({ ...lastInput, observedAt: now() });
          check();
        },
        check,
      );
      const sources: StoreOptions["sources"] = {
        withHeldCurrentObservation(actual, input, work) {
          return protect(async () => {
            if (
              actual !== tx ||
              ++sourceCalls !== 1 ||
              !same(
                parseCatalogProductPublicationWarningAcknowledgementCommand(input.command),
                command,
              )
            )
              return reject();
            const inputDeadline = parseCatalogInstant(input.validUntil);
            if (inputDeadline < validUntil) validUntil = inputDeadline;
            check();
            let calls = 0,
              open = true,
              returned: { value: Awaited<ReturnType<typeof work>> } | undefined;
            try {
              const result = await observe(actual, input, (value) =>
                protect(async () => {
                  if (!open || ++calls !== 1) return reject();
                  const observation =
                    parseCatalogProductPublicationWarningAcknowledgementObservation(value);
                  if (
                    observation.acknowledgementOperationReference !== command.operationReference ||
                    observation.acknowledgementIntentDigest !== commandHash ||
                    observation.actorReference !== command.actorReference ||
                    observation.productAggregateVersion !==
                      command.expectedProductAggregateVersion ||
                    observation.observedAt > now()
                  )
                    return reject();
                  if (observation.validUntil < validUntil) validUntil = observation.validUntil;
                  check();
                  const valueResult = await work(observation);
                  check();
                  returned = { value: valueResult };
                  return returned;
                }),
              );
              if (calls !== 1 || !returned || result !== returned) return reject();
              check();
              return returned.value;
            } finally {
              open = false;
            }
          });
        },
      };
      const store = createPostgresProductPublicationWarningAcknowledgementStore({
        tenantReference: command.tenantReference,
        brandReference: command.brandReference,
        actorReference: command.actorReference,
        clock: { now },
        transactions: { run: (work) => work(tx) },
        registerBeforeCommit: host.registerBeforeCommit,
        authority: {
          holdUntilTransactionCompletes: (actual, input) =>
            protect(async () => {
              if (actual !== tx) return reject();
              await current(input);
            }),
        },
        sources,
        contentAuthority: {
          holdUntilTransactionCompletes: (actual, input) =>
            protect(async () => {
              if (actual !== tx) return reject();
              check();
              if ((await contentHold(actual, input)) !== undefined) return reject();
              check();
            }),
        },
        historyAuthority: {
          holdUntilTransactionCompletes: (actual, input) =>
            protect(async () => {
              if (actual !== tx) return reject();
              check();
              if ((await historyHold(actual, input)) !== undefined) return reject();
              check();
            }),
        },
        reportAuthority: {
          holdUntilTransactionCompletes: (actual, input) =>
            protect(async () => {
              if (actual !== tx) return reject();
              check();
              if ((await reportHold(actual, input)) !== undefined) return reject();
              check();
            }),
        },
        categoryAssignments: createMerchantProductCategoryAssignments({
          transaction: tx,
          tenantReference: command.tenantReference,
          brandReference: command.brandReference,
          actorReference: command.actorReference,
          now,
          policy: categoryPolicy,
          registerBeforeCommit: host.registerBeforeCommit,
        }),
        audit: {
          create(receipt) {
            return {
              auditId: parseCatalogReference(auditReference(receipt.command.operationReference)),
              brandId: receipt.command.brandReference,
              actor: { type: "User", reference: receipt.command.actorReference },
              actionCode: "CATALOG_PRODUCT_PUBLICATION_WARNINGS_ACKNOWLEDGED",
              targetType: "Product",
              targetId: receipt.command.productReference,
              reasonCode: receipt.command.reasonCode,
              correlationId: receipt.command.operationReference,
              occurredAt: receipt.recordedAt,
              sourceChannel: "API",
              dataClassification: "Internal",
              retentionPolicyCode: "OPERATIONAL",
              retentionPolicyVersion: 1,
            };
          },
        },
      });
      const written = await store.execute(command);
      check();
      const receipt = parseCatalogProductPublicationWarningAcknowledgementReceipt(written.receipt);
      if (
        !same(receipt.command, command) ||
        (written.status !== "Applied" && written.status !== "Replayed") ||
        (written.status === "Applied" ? sourceCalls !== 1 : sourceCalls !== 0)
      )
        return reject();
      const value = Object.freeze({
        profile: "CatalogProductPublicationWarningAcknowledgementResultV1" as const,
        status: written.status,
        operationReference: receipt.command.operationReference,
        productReference: receipt.command.productReference,
        versionReference: receipt.command.versionReference,
        aggregateVersion: receipt.command.expectedProductAggregateVersion,
        reportOperationReference: receipt.command.reportOperationReference,
        reportDigest: receipt.command.reportDigest,
        warningBindingDigest: receipt.command.warningBindingDigest,
        warningCodes: receipt.command.warningCodes,
        reasonCode: receipt.command.reasonCode,
        occurredAt: receipt.command.occurredAt,
        recordedAt: receipt.recordedAt,
        receiptDigest: receipt.digest,
      });
      completed = { result: value };
      return value;
    });
    if (transactionCalls !== 1 || !completed || completed.result !== result) return reject();
    now();
    return result;
  };
}
