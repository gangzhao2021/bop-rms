import { canonicalizeRfc8785 } from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { createPostgresTransactionCurrentPermissionPolicySource } from "@bop/permission";
import { CatalogError, copyCategoryPersistenceValue, parseCatalogInstant } from "@rms/catalog";
import {
  createCurrencyMetadataSnapshot,
  createPostgresOptionPriceAuthoringStore,
  OptionPriceAuthoringError,
  parseOptionPriceAuthoringCommand,
  parsePricingReference,
  optionPriceAuthoringFields,
  optionPriceWireState,
  type CurrencyMetadataSnapshot,
  type OptionPriceAuthoringCommand,
  type OptionPriceAuthoringOperation,
} from "@rms/pricing";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import {
  createMerchantOptionPriceContextSource,
  type MerchantOptionPriceContext,
  type MerchantOptionPriceContextRequest,
} from "./merchant-option-price-context.js";
import { createMerchantOptionPricePublicationAuthority } from "./merchant-option-price-publication-authority.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export interface MerchantOptionPriceAuthoringCommandOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly publicationPolicyFamilyReference: string;
  readonly references: { generate(kind: "OptionPriceVersion" | "Audit" | "Event"): string };
}
export interface MerchantOptionPriceAuthoringRequest {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly expectedScope: unknown;
  readonly command: unknown;
}
/** A caller intent anchor only. It is not part of the owning command identity
 * and cannot alter an immutable original-operation replay. */
export interface MerchantOptionPriceExecuteRequest extends MerchantOptionPriceAuthoringRequest {
  readonly context: {
    readonly productReference: string;
    readonly expectedProductAggregateVersion: number;
  };
}
export interface MerchantOptionPriceAuthoringResult {
  readonly profile: "MerchantOptionPriceAuthoringResultV1";
  readonly action: OptionPriceAuthoringCommand["action"];
  readonly operationReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly outcome: OptionPriceAuthoringOperation["outcome"];
  readonly state: ReturnType<typeof optionPriceWireState> | null;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MerchantOptionPriceScopeRequest {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly expectedScope: unknown;
}
export interface MerchantOptionPriceScopeResult {
  readonly profile: "MerchantOptionPriceScopeV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MerchantOptionPriceAuthoringQueryRequest {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly expectedScope: unknown;
  readonly context: MerchantOptionPriceContextRequest;
}
export interface MerchantOptionPriceAuthoringQueryResult {
  readonly profile: "MerchantOptionPriceAuthoringQueryV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly context: MerchantOptionPriceContext;
  readonly states: readonly ReturnType<typeof optionPriceWireState>[];
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (
  code: ConstructorParameters<
    typeof OptionPriceAuthoringError
  >[0] = "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new OptionPriceAuthoringError(code);
};
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
const bounded = (error: unknown): never => {
  if (
    error instanceof OptionPriceAuthoringError ||
    error instanceof MerchantProductWriteFeatureDisabled
  )
    throw error;
  if (
    error instanceof BrowserSessionError ||
    (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
  )
    return fail("OPTION_PRICE_PERMISSION_DENIED");
  if (error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID")
    return fail("OPTION_PRICE_INPUT_INVALID");
  if (error instanceof CatalogError && error.code === "CATALOG_VERSION_CONFLICT")
    return fail("OPTION_PRICE_VERSION_CONFLICT");
  return fail();
};

/** Ordinary server composition. The Pricing owner arbitrates the global original
 * operation before any Catalog qualification, then retains Catalog→Publishing→
 * Pricing sources and the genuine outer host through COMMIT. */
export function createMerchantOptionPriceAuthoringCommand(
  options: MerchantOptionPriceAuthoringCommandOptions,
) {
  if (
    typeof options.merchant?.now !== "function" ||
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.currentActor !== "function" ||
    typeof options.merchant?.validateAssociation !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    typeof options.references?.generate !== "function"
  )
    return fail();
  const clock = options.merchant.now.bind(options.merchant),
    run = options.merchant.transactions.run.bind(options.merchant.transactions),
    authenticate = options.authentication.authorize.bind(options.authentication),
    generate = options.references.generate.bind(options.references),
    family = parsePricingReference(options.publicationPolicyFamilyReference),
    currency = createCurrencyMetadataSnapshot(options.currencyMetadata),
    merchant = Object.freeze({
      ...options.merchant,
      now: clock,
      transactions: { run },
      currentActor: options.merchant.currentActor.bind(options.merchant),
      validateAssociation: options.merchant.validateAssociation.bind(options.merchant),
    }),
    host = createMerchantCategoryTransactions({ run });
  const perform = async (
    mode: "Execute" | "Resolve",
    request: MerchantOptionPriceAuthoringRequest,
    anchorValue?: unknown,
  ): Promise<MerchantOptionPriceAuthoringResult> => {
    try {
      const command = parseOptionPriceAuthoringCommand(
          copyCategoryPersistenceValue(request.command),
        ),
        expected = parseMerchantProductCommandScope(request.expectedScope),
        anchor =
          mode === "Resolve"
            ? null
            : (() => {
                try {
                  const raw = readClosedRecord(copyCategoryPersistenceValue(anchorValue), [
                    "productReference",
                    "expectedProductAggregateVersion",
                  ]);
                  if (
                    typeof raw.expectedProductAggregateVersion !== "number" ||
                    !Number.isSafeInteger(raw.expectedProductAggregateVersion) ||
                    raw.expectedProductAggregateVersion < 1 ||
                    raw.expectedProductAggregateVersion > 2147483647
                  )
                    return fail("OPTION_PRICE_INPUT_INVALID");
                  return Object.freeze({
                    productReference: parsePricingReference(raw.productReference),
                    expectedProductAggregateVersion: raw.expectedProductAggregateVersion,
                  });
                } catch {
                  return fail("OPTION_PRICE_INPUT_INVALID");
                }
              })(),
        sessionCookie = request.sessionCookie,
        csrf = request.csrf,
        started = parseCatalogInstant(clock()),
        originalUntil = parseCatalogInstant(new Date(Date.parse(started) + 5000).toISOString());
      let deadline = originalUntil,
        latest = started,
        failed = false,
        transactions = 0,
        hostFinalized = false,
        finalOwner: (() => string) | undefined,
        finalContext: (() => string) | undefined,
        finalPublication: (() => string) | undefined;
      const reject = (error?: unknown): never => {
        failed = true;
        return bounded(error);
      };
      const now = () => {
        try {
          const at = parseCatalogInstant(clock());
          if (failed || at < latest || at >= deadline) return reject();
          latest = at;
          return at;
        } catch (error) {
          return reject(error);
        }
      };
      const tighten = (value: string) => {
        const until = parseCatalogInstant(value);
        if (until > originalUntil) return reject();
        if (until < deadline) deadline = until;
        now();
      };
      const session = await authenticate({ sessionCookie, csrf });
      now();
      const result = await host.transactions.run(async (tx) => {
        if (++transactions !== 1) return reject();
        const query = tx.query,
          permissionPolicy = createPostgresTransactionCurrentPermissionPolicySource(tx);
        const check = () => {
          if (tx.query !== query) return reject();
          return now();
        };
        const brandScope = await createMerchantBrandScope(merchant, permissionPolicy)(
            tx,
            sessionCookie,
            session.sessionReference,
          ),
          storeScope = await createMerchantStoreScope(merchant, permissionPolicy)(
            tx,
            sessionCookie,
            "merchant.access",
            session.sessionReference,
          ),
          bound = bindMerchantProductCommandScope(
            {
              brandReference: brandScope.context.brand.brandReference,
              storeReference: brandScope.selectedStoreReference,
            },
            expected,
          ),
          tenant = parsePricingReference(brandScope.tenantReference),
          actor = parsePricingReference(brandScope.actorReference),
          brand = parsePricingReference(bound.brandReference),
          store = parsePricingReference(bound.storeReference);
        if (
          storeScope.selected.tenantReference !== tenant ||
          String(storeScope.context.brand.brandReference) !== brand ||
          String(storeScope.store.storeReference) !== store ||
          String(storeScope.actorReference) !== actor ||
          storeScope.sessionReference !== session.sessionReference
        )
          return reject();
        const current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope: brandScope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now: check },
            originalValidUntil: originalUntil,
            permissionPolicy,
            capabilityKey: "pricing.price_book_editor",
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            actorReference: actor,
            clock: { now: check },
            originalValidUntil: originalUntil,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey: "pricing.price_book_editor",
          });
        const assertPort = current.assertCurrent,
          authorizePort = current.authorizeActions,
          leasePort = current.leaseDeadline,
          holdPort = capability.holdUntilCommit,
          capLeasePort = capability.leaseDeadline;
        if (typeof leasePort !== "function" || typeof capLeasePort !== "function") return reject();
        const assert = assertPort.bind(current),
          authorize = authorizePort.bind(current),
          lease = leasePort.bind(current),
          hold = holdPort.bind(capability),
          capLease = capLeasePort.bind(capability);
        const holdAgain = async () => {
          check();
          if (
            current.assertCurrent !== assertPort ||
            current.authorizeActions !== authorizePort ||
            current.leaseDeadline !== leasePort ||
            capability.holdUntilCommit !== holdPort ||
            capability.leaseDeadline !== capLeasePort
          )
            return reject();
          assert();
          if (
            (await hold()) !== undefined ||
            (await authorize(["pricing.price-book.manage"])) !== undefined
          )
            return reject();
          tighten(lease());
          tighten(capLease());
          check();
        };
        let ready = false,
          guarding = false,
          guardDone = false,
          finalDone = false;
        await host.registerBeforeCommit(
          tx,
          async () => {
            try {
              if (!ready || guarding || guardDone) return reject();
              guarding = true;
              await holdAgain();
              guardDone = true;
            } catch (error) {
              return reject(error);
            }
          },
          () => {
            if (!ready || !guardDone || finalDone) return reject();
            assert();
            check();
            finalDone = true;
            hostFinalized = true;
          },
        );
        await holdAgain();
        const common = {
            transaction: tx,
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            actorReference: actor,
            sessionReference: String(session.sessionReference),
            clock: { now: check },
            originalValidUntil: originalUntil,
            currentAuthorization: current,
            capability,
            registerBeforeCommit: host.registerBeforeCommit,
          },
          publication =
            mode === "Execute" && command.action === "Publish"
              ? createMerchantOptionPricePublicationAuthority({
                  ...common,
                  originalObservedAt: started,
                  operationReference: command.operationReference,
                  ruleReference: command.ruleReference,
                  expectedAggregateVersion: command.expectedAggregateVersion ?? reject(),
                  publicationPolicyFamilyReference: family,
                })
              : undefined;
        let context: MerchantOptionPriceContext | undefined;
        const owner = createPostgresOptionPriceAuthoringStore({
          transaction: tx,
          tenantReference: tenant,
          brandReference: brand,
          selectedStoreReference: store,
          actorReference: actor,
          currencyMetadata: currency,
          originalObservedAt: started,
          originalValidUntil: originalUntil,
          clock: { now: check },
          ...(publication
            ? { publicationPolicyFamilyReference: family, publicationSource: publication }
            : {}),
          registerBeforeCommit(actual, guard, final) {
            if (actual !== tx) return reject();
            return host.registerBeforeCommit(tx, guard, final);
          },
          references: { generate: (kind) => parsePricingReference(generate(kind)) },
          audit: {
            create(input) {
              return {
                auditId: input.auditReference,
                brandId: brand,
                actor: { type: "User", reference: actor },
                actionCode:
                  input.mode === "Abandon"
                    ? "PRICING_OPTION_PRICE_RESOLVE"
                    : "PRICING_OPTION_PRICE_" + input.command.action.toUpperCase(),
                targetType: "PricingOptionPriceRule",
                targetId: input.command.ruleReference,
                reasonCode: "AUTHORIZED_OPERATION",
                correlationId: input.command.operationReference,
                occurredAt: input.occurredAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              };
            },
          },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              try {
                readClosedRecord(input, [
                  "tenantReference",
                  "brandReference",
                  "selectedStoreReference",
                  "actorReference",
                  "permission",
                  "purposeCode",
                  "requiredFields",
                  "mode",
                  "command",
                  "state",
                  "observedAt",
                  "originalObservedAt",
                  "originalValidUntil",
                ]);
                const at = parseCatalogInstant(input.observedAt);
                if (
                  actual !== tx ||
                  input.tenantReference !== tenant ||
                  input.brandReference !== brand ||
                  input.selectedStoreReference !== store ||
                  input.actorReference !== actor ||
                  input.permission !== "pricing.price-book.manage" ||
                  input.purposeCode !== "PRICING_OPTION_PRICE_AUTHORING" ||
                  !equal(input.requiredFields, optionPriceAuthoringFields) ||
                  !["Read", "Write", "Resolve"].includes(input.mode) ||
                  !input.command ||
                  !equal(input.command, command) ||
                  input.originalObservedAt !== started ||
                  input.originalValidUntil !== originalUntil ||
                  at < started ||
                  at > check()
                )
                  return reject();
                await holdAgain();
                if (input.mode === "Write") {
                  if (mode !== "Execute" || !anchor) return reject();
                  const bindingReference =
                      input.state?.bindingReference ?? command.bindingReference,
                    optionReference = input.state?.optionReference ?? command.optionReference;
                  if (!bindingReference || !optionReference) return reject();
                  if (!context) {
                    const source = createMerchantOptionPriceContextSource({
                      ...common,
                      brandScope,
                      storeScope,
                      currencyMetadata: currency,
                      events: { generateReference: () => reject() },
                    });
                    context = await source.withCurrentContext(
                      tx,
                      { ...anchor, bindingReference, optionReference },
                      async (packet) => packet,
                    );
                    finalContext = () => source.assertFinalized(tx);
                  }
                  if (
                    String(context.binding.bindingReference) !== String(bindingReference) ||
                    context.optionReference !== optionReference ||
                    context.tenantReference !== tenant ||
                    context.brandReference !== brand ||
                    context.storeReference !== store ||
                    context.actorReference !== actor ||
                    !equal(context.currencyMetadata, currency)
                  )
                    return reject();
                  const target =
                    command.content ?? input.state?.draft ?? input.state?.latestVersion;
                  if (!target) return reject();
                  if (
                    (target.scopeKind === "Brand" && target.scopeReference !== null) ||
                    (target.scopeKind === "Store" && target.scopeReference !== store) ||
                    (target.scopeKind !== "Brand" && target.scopeKind !== "Store")
                  )
                    return reject();
                  if (
                    target.skuReference !== null &&
                    !context.skus.some((sku) => sku.skuReference === target.skuReference)
                  )
                    return reject();
                }
                check();
                return deadline;
              } catch (error) {
                return reject(error);
              }
            },
          },
        });
        const operation =
          mode === "Execute" ? await owner.execute(command) : await owner.resolve(command);
        finalOwner = owner.assertFinalized.bind(owner);
        // A configured producer is only consumed on a real new Publish. Replays
        // intentionally do not acquire the current policy or old Binding graph.
        if (publication && context)
          finalPublication = publication.assertFinalized.bind(publication);
        if (
          operation.tenantReference !== tenant ||
          operation.brandReference !== brand ||
          operation.actorReference !== actor ||
          !equal(operation.command, command)
        )
          return reject();
        await holdAgain();
        ready = true;
        return Object.freeze({
          profile: "MerchantOptionPriceAuthoringResultV1" as const,
          action: command.action,
          operationReference: String(command.operationReference),
          tenantReference: String(tenant),
          brandReference: String(brand),
          storeReference: String(store),
          actorReference: String(actor),
          outcome: operation.outcome,
          state: operation.state === null ? null : optionPriceWireState(operation.state),
          occurredAt: operation.occurredAt,
          observedAt: check(),
          validUntil: deadline,
        });
      });
      if (!hostFinalized || transactions !== 1 || !finalOwner) return reject();
      tighten(finalOwner());
      if (finalContext) tighten(finalContext());
      if (finalPublication) tighten(finalPublication());
      now();
      return Object.freeze({ ...result, validUntil: deadline });
    } catch (error) {
      return bounded(error);
    }
  };
  const read = async (
    mode: "Query" | "Scope",
    request: MerchantOptionPriceScopeRequest,
    selectorValue?: unknown,
  ): Promise<MerchantOptionPriceAuthoringQueryResult | MerchantOptionPriceScopeResult> => {
    try {
      let selectedRequest: MerchantOptionPriceContextRequest | null = null;
      if (mode === "Query") {
        try {
          const raw = readClosedRecord(copyCategoryPersistenceValue(selectorValue), [
            "productReference",
            "expectedProductAggregateVersion",
            "bindingReference",
            "optionReference",
          ]);
          if (
            typeof raw.expectedProductAggregateVersion !== "number" ||
            !Number.isSafeInteger(raw.expectedProductAggregateVersion) ||
            raw.expectedProductAggregateVersion < 1 ||
            raw.expectedProductAggregateVersion > 2147483647
          )
            return fail("OPTION_PRICE_INPUT_INVALID");
          selectedRequest = Object.freeze({
            productReference: parsePricingReference(raw.productReference),
            expectedProductAggregateVersion: raw.expectedProductAggregateVersion,
            bindingReference: parsePricingReference(raw.bindingReference),
            optionReference: parsePricingReference(raw.optionReference),
          });
        } catch {
          return fail("OPTION_PRICE_INPUT_INVALID");
        }
      }
      const expected = parseMerchantProductCommandScope(request.expectedScope),
        sessionCookie = request.sessionCookie,
        csrf = request.csrf,
        started = parseCatalogInstant(clock()),
        originalUntil = parseCatalogInstant(new Date(Date.parse(started) + 5000).toISOString());
      let latest = started,
        deadline = originalUntil,
        failed = false,
        entered = false,
        finalized = false,
        ownerFinal: (() => string) | undefined,
        contextFinal: (() => string) | undefined,
        scopeFinal: (() => string) | undefined;
      const reject = (error?: unknown): never => {
        failed = true;
        return bounded(error);
      };
      const now = () => {
        try {
          const at = parseCatalogInstant(clock());
          if (failed || at < latest || at >= deadline) return reject();
          latest = at;
          return at;
        } catch (error) {
          return reject(error);
        }
      };
      const tighten = (value: string) => {
        const until = parseCatalogInstant(value);
        if (until > originalUntil) return reject();
        if (until < deadline) deadline = until;
        now();
      };
      const session = await authenticate({ sessionCookie, csrf });
      now();
      const result = await host.transactions.run(async (tx) => {
        if (entered) return reject();
        entered = true;
        const queryPort = tx.query,
          permissionPolicy = createPostgresTransactionCurrentPermissionPolicySource(tx),
          check = () => {
            if (tx.query !== queryPort) return reject();
            return now();
          },
          brandScope = await createMerchantBrandScope(merchant, permissionPolicy)(
            tx,
            sessionCookie,
            session.sessionReference,
          ),
          storeScope = await createMerchantStoreScope(merchant, permissionPolicy)(
            tx,
            sessionCookie,
            "merchant.access",
            session.sessionReference,
          ),
          bound = bindMerchantProductCommandScope(
            {
              brandReference: brandScope.context.brand.brandReference,
              storeReference: brandScope.selectedStoreReference,
            },
            expected,
          ),
          tenant = parsePricingReference(brandScope.tenantReference),
          brand = parsePricingReference(bound.brandReference),
          store = parsePricingReference(bound.storeReference),
          actor = parsePricingReference(brandScope.actorReference);
        if (
          storeScope.selected.tenantReference !== tenant ||
          String(storeScope.context.brand.brandReference) !== brand ||
          String(storeScope.store.storeReference) !== store ||
          String(storeScope.actorReference) !== actor ||
          storeScope.sessionReference !== session.sessionReference
        )
          return reject();
        const current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope: brandScope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now: check },
            originalValidUntil: originalUntil,
            permissionPolicy,
            capabilityKey: "pricing.price_book_editor",
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            actorReference: actor,
            clock: { now: check },
            originalValidUntil: originalUntil,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey: "pricing.price_book_editor",
          }),
          assertPort = current.assertCurrent,
          authorizePort = current.authorizeActions,
          leasePort = current.leaseDeadline,
          holdPort = capability.holdUntilCommit,
          capLeasePort = capability.leaseDeadline;
        if (typeof leasePort !== "function" || typeof capLeasePort !== "function") return reject();
        const assert = assertPort.bind(current),
          authorize = authorizePort.bind(current),
          lease = leasePort.bind(current),
          hold = holdPort.bind(capability),
          capLease = capLeasePort.bind(capability);
        const rehold = async () => {
          check();
          if (
            current.assertCurrent !== assertPort ||
            current.authorizeActions !== authorizePort ||
            current.leaseDeadline !== leasePort ||
            capability.holdUntilCommit !== holdPort ||
            capability.leaseDeadline !== capLeasePort
          )
            return reject();
          assert();
          if (
            (await hold()) !== undefined ||
            (await authorize(["pricing.price-book.manage"])) !== undefined
          )
            return reject();
          tighten(lease());
          tighten(capLease());
          check();
        };
        let ready = false,
          guarded = false,
          finalDone = false;
        await host.registerBeforeCommit(
          tx,
          async () => {
            try {
              if (!ready || guarded) return reject();
              await rehold();
              guarded = true;
            } catch (error) {
              return reject(error);
            }
          },
          () => {
            if (!ready || !guarded || finalDone) return reject();
            assert();
            check();
            finalDone = true;
            finalized = true;
          },
        );
        await rehold();
        if (mode === "Scope") {
          scopeFinal = () => {
            if (
              !finalized ||
              current.assertCurrent !== assertPort ||
              current.authorizeActions !== authorizePort ||
              current.leaseDeadline !== leasePort ||
              capability.holdUntilCommit !== holdPort ||
              capability.leaseDeadline !== capLeasePort
            )
              return reject();
            assert();
            const authorizationUntil = lease(),
              capabilityUntil = capLease();
            check();
            return authorizationUntil < capabilityUntil ? authorizationUntil : capabilityUntil;
          };
          ready = true;
          return Object.freeze({
            profile: "MerchantOptionPriceScopeV1" as const,
            tenantReference: String(tenant),
            brandReference: String(brand),
            storeReference: String(store),
            actorReference: String(actor),
            observedAt: check(),
            validUntil: deadline,
          });
        }
        if (selectedRequest === null) return reject();
        const selector = selectedRequest;
        const source = createMerchantOptionPriceContextSource({
          transaction: tx,
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          actorReference: actor,
          sessionReference: String(session.sessionReference),
          clock: { now: check },
          originalValidUntil: originalUntil,
          currentAuthorization: current,
          capability,
          registerBeforeCommit: host.registerBeforeCommit,
          brandScope,
          storeScope,
          currencyMetadata: currency,
          events: { generateReference: () => reject() },
        });
        const selected = await source.withCurrentContext(tx, selector, async (context) => context);
        if (
          selected.tenantReference !== tenant ||
          selected.brandReference !== brand ||
          selected.storeReference !== store ||
          selected.actorReference !== actor ||
          selected.productReference !== selector.productReference ||
          selected.productAggregateVersion !== selector.expectedProductAggregateVersion ||
          selected.binding.bindingReference !== selector.bindingReference ||
          selected.optionReference !== selector.optionReference
        )
          return reject();
        contextFinal = () => source.assertFinalized(tx);
        const owner = createPostgresOptionPriceAuthoringStore({
          transaction: tx,
          tenantReference: tenant,
          brandReference: brand,
          selectedStoreReference: store,
          actorReference: actor,
          currencyMetadata: currency,
          originalObservedAt: started,
          originalValidUntil: originalUntil,
          clock: { now: check },
          registerBeforeCommit(actual, guard, final) {
            if (actual !== tx) return reject();
            return host.registerBeforeCommit(tx, guard, final);
          },
          references: { generate: () => reject() },
          audit: { create: () => reject() },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              try {
                readClosedRecord(input, [
                  "tenantReference",
                  "brandReference",
                  "selectedStoreReference",
                  "actorReference",
                  "permission",
                  "purposeCode",
                  "requiredFields",
                  "mode",
                  "command",
                  "state",
                  "observedAt",
                  "originalObservedAt",
                  "originalValidUntil",
                ]);
                const at = parseCatalogInstant(input.observedAt);
                if (
                  actual !== tx ||
                  input.tenantReference !== tenant ||
                  input.brandReference !== brand ||
                  input.selectedStoreReference !== store ||
                  input.actorReference !== actor ||
                  input.permission !== "pricing.price-book.manage" ||
                  input.purposeCode !== "PRICING_OPTION_PRICE_AUTHORING" ||
                  !equal(input.requiredFields, optionPriceAuthoringFields) ||
                  input.mode !== "Read" ||
                  input.command !== null ||
                  input.originalObservedAt !== started ||
                  input.originalValidUntil !== originalUntil ||
                  at < started ||
                  at > check() ||
                  (input.state !== null &&
                    (input.state.brandReference !== brand ||
                      input.state.bindingReference !== selector.bindingReference ||
                      input.state.optionReference !== selector.optionReference))
                )
                  return reject();
                await rehold();
                return deadline;
              } catch (error) {
                return reject(error);
              }
            },
          },
        });
        const states = await owner.listForBinding({
          bindingReference: selector.bindingReference,
          optionReference: selector.optionReference,
        });
        if (!Array.isArray(states) || states.length > 1000) return reject();
        const seen = new Set<string>();
        for (const state of states) {
          if (
            state.brandReference !== brand ||
            state.bindingReference !== selector.bindingReference ||
            state.optionReference !== selector.optionReference ||
            seen.has(state.ruleReference)
          )
            return reject();
          seen.add(state.ruleReference);
        }
        ownerFinal = owner.assertFinalized.bind(owner);
        await rehold();
        ready = true;
        return Object.freeze({
          profile: "MerchantOptionPriceAuthoringQueryV1" as const,
          tenantReference: String(tenant),
          brandReference: String(brand),
          storeReference: String(store),
          actorReference: String(actor),
          context: selected,
          states: Object.freeze(states.map(optionPriceWireState)),
          observedAt: check(),
          validUntil: deadline,
        });
      });
      if (!entered || !finalized) return reject();
      if (result.profile === "MerchantOptionPriceScopeV1") {
        if (ownerFinal !== undefined || contextFinal !== undefined || !scopeFinal) return reject();
        tighten(scopeFinal());
        now();
        return Object.freeze({ ...result, validUntil: deadline });
      }
      if (!ownerFinal || !contextFinal) return reject();
      tighten(ownerFinal());
      tighten(contextFinal());
      now();
      return Object.freeze({
        ...result,
        context: Object.freeze({ ...result.context, validUntil: deadline }),
        validUntil: deadline,
      });
    } catch (error) {
      return bounded(error);
    }
  };
  return Object.freeze({
    execute(request: MerchantOptionPriceExecuteRequest) {
      return perform("Execute", request, request.context);
    },
    resolve(request: MerchantOptionPriceAuthoringRequest) {
      return perform("Resolve", request);
    },
    async query(
      request: MerchantOptionPriceAuthoringQueryRequest,
    ): Promise<MerchantOptionPriceAuthoringQueryResult> {
      const result = await read("Query", request, request.context);
      if (result.profile !== "MerchantOptionPriceAuthoringQueryV1") return fail();
      return result;
    },
    async scope(request: MerchantOptionPriceScopeRequest): Promise<MerchantOptionPriceScopeResult> {
      const result = await read("Scope", request);
      if (result.profile !== "MerchantOptionPriceScopeV1") return fail();
      return result;
    },
  });
}
