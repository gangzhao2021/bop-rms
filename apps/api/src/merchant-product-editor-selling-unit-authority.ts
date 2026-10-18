import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  catalogSellingUnitRegistryDigest,
  copyCategoryPersistenceValue,
  createPostgresSellingUnitRegistryStore,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
  sellingUnitRegistryFields,
} from "@rms/catalog";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import type {
  MerchantProductEditorContentAuthority,
  MerchantProductEditorContentAuthorityInput,
} from "./merchant-product-editor-content-authority.js";

type Tx = Parameters<MerchantProductEditorContentAuthority>[0];
type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Bridge = ReturnType<typeof createMerchantProductCurrentAuthorization>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** Actual unit registration is independent of complete fields and other references.
 * This adapter owns no unit data and grants no SKU create/update permission. */
export function createMerchantProductEditorSellingUnitAuthority(options: {
  readonly transaction: Tx;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly purposeCode: MerchantProductEditorContentAuthorityInput["purposeCode"];
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly currentAuthorization: Bridge;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
  readonly remainingAuthority: MerchantProductEditorContentAuthority;
}): MerchantProductEditorContentAuthority {
  if (
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.currentAuthorization?.authorizeActions !== "function" ||
    typeof options.currentAuthorization?.assertCurrent !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.remainingAuthority !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    authorize = options.currentAuthorization.authorizeActions.bind(options.currentAuthorization),
    assertAuthorization = options.currentAuthorization.assertCurrent.bind(
      options.currentAuthorization,
    ),
    register = options.registerBeforeCommit.bind(options),
    remaining = options.remainingAuthority,
    startedAt = parseCatalogInstant(now()),
    hostDeadline = parseCatalogInstant(options.originalValidUntil),
    identity = Object.freeze({
      tenantReference: parseCatalogReference(options.tenantReference),
      brandReference: parseCatalogReference(options.brandReference),
      storeReference: parseCatalogReference(options.storeReference),
      actorReference: parseCatalogReference(options.actorReference),
      sessionReference: parseCatalogReference(options.sessionReference),
      productReference: parseCatalogReference(options.productReference),
      operationReference: parseCatalogReference(options.operationReference),
      purposeCode: options.purposeCode,
    });
  if (
    !["CATALOG_PRODUCT_CREATE", "CATALOG_PRODUCT_DRAFT_REPLACE"].includes(identity.purposeCode) ||
    hostDeadline <= startedAt ||
    Date.parse(hostDeadline) - Date.parse(startedAt) > 5000
  )
    return fail();
  let latest = startedAt,
    deadline = hostDeadline,
    failed = false,
    active = false,
    registered = false,
    guardRan = false,
    finalized = false;
  let originalWrite: {
    readonly fingerprint: string;
    readonly input: MerchantProductEditorContentAuthorityInput;
    readonly acquired: boolean;
  } | null = null;
  const poison = (): never => {
    failed = true;
    return fail();
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (
      error instanceof CatalogError &&
      [
        "CATALOG_PERMISSION_DENIED",
        "CATALOG_LIFECYCLE_CONFLICT",
        "CATALOG_DEPENDENCY_UNAVAILABLE",
      ].includes(error.code)
    )
      throw error;
    return fail();
  };
  const check = (childFinal = false) => {
    try {
      const at = parseCatalogInstant(now());
      if (
        failed ||
        tx.query !== query ||
        at < latest ||
        at >= deadline ||
        (finalized && !childFinal)
      )
        return poison();
      assertAuthorization();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const current = async () => {
    check();
    if ((await authorize(Object.freeze(["catalog.manage"]))) !== undefined) return poison();
    check();
  };
  const remainingFields = async (input: MerchantProductEditorContentAuthorityInput) => {
    check();
    if ((await remaining(tx, input)) !== undefined) return poison();
    check();
  };
  return async (actual, value) => {
    try {
      if (actual !== tx || active || finalized) return poison();
      active = true;
      const captured = copyCategoryPersistenceValue(value);
      if (!registered) {
        registered = true;
        if (
          (await register(
            tx,
            async () => {
              try {
                if (guardRan || active) return poison();
                guardRan = true;
                await current();
              } catch (error) {
                return reject(error);
              }
            },
            () => {
              if (!guardRan || active || finalized) return poison();
              check();
              finalized = true;
            },
          )) !== undefined
        )
          return poison();
        check();
      }
      check();
      const raw = readClosedRecord(captured, [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "sessionReference",
        "productReference",
        "operationReference",
        "permission",
        "owningAction",
        "purposeCode",
        "observedAt",
        "validUntil",
        "mode",
        "aggregate",
        "requiredFields",
        "requiredReferenceChecks",
      ]);
      for (const key of Object.keys(identity) as (keyof typeof identity)[])
        if (raw[key] !== identity[key]) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const aggregate = parseProductAggregate(raw.aggregate),
        observedAt = parseCatalogInstant(raw.observedAt),
        validUntil = parseCatalogInstant(raw.validUntil);
      if (
        !["Read", "DraftWrite"].includes(String(raw.mode)) ||
        raw.permission !== "catalog.manage" ||
        raw.owningAction !== "catalog.product.manage" ||
        Date.parse(validUntil) - Date.parse(observedAt) !== 5000 ||
        observedAt < startedAt ||
        observedAt > check() ||
        aggregate.brandReference !== identity.brandReference ||
        aggregate.productReference !== identity.productReference ||
        aggregate.draft.editorContent === undefined ||
        JSON.stringify(raw.requiredFields) !== JSON.stringify(productEditorContentFields) ||
        JSON.stringify(raw.requiredReferenceChecks) !==
          JSON.stringify(raw.mode === "Read" ? [] : productEditorContentReferenceChecks)
      )
        return poison();
      if (
        identity.purposeCode === "CATALOG_PRODUCT_CREATE" &&
        (aggregate.aggregateVersion !== 1 ||
          (raw.mode === "DraftWrite" &&
            (aggregate.lifecycle !== "Draft" ||
              aggregate.createdByActorReference !== identity.actorReference)))
      )
        return poison();
      const input: MerchantProductEditorContentAuthorityInput = Object.freeze({
        ...identity,
        permission: "catalog.manage",
        owningAction: "catalog.product.manage",
        observedAt,
        validUntil,
        mode: raw.mode as "Read" | "DraftWrite",
        aggregate,
        requiredFields: productEditorContentFields,
        requiredReferenceChecks:
          raw.mode === "Read" ? Object.freeze([]) : productEditorContentReferenceChecks,
      });
      deadline = [deadline, validUntil].sort()[0] ?? poison();
      await current();
      if (input.mode === "Read") return await remainingFields(input);
      const fingerprint = hash(input);
      if (originalWrite) {
        if (originalWrite.fingerprint !== fingerprint || !originalWrite.acquired) return poison();
        return await remainingFields(input);
      }
      originalWrite = Object.freeze({ fingerprint, input, acquired: false });
      if (aggregate.draft.skus.length === 0) {
        // Actual empty SKU membership needs no invented registry. Other complete
        // field/reference checks remain mandatory, including future added SKUs.
        await remainingFields(input);
        originalWrite = Object.freeze({ fingerprint, input, acquired: true });
        return;
      }
      const request = Object.freeze({
        tenantReference: identity.tenantReference,
        brandReference: identity.brandReference,
        productReference: identity.productReference,
        operationReference: identity.operationReference,
        purposeCode: identity.purposeCode,
        aggregate,
        originalIntentDigest: fingerprint,
        observedAt,
        validUntil,
      });
      const source = createPostgresSellingUnitRegistryStore({
        tenantReference: identity.tenantReference,
        brandReference: identity.brandReference,
        actorReference: identity.actorReference,
        actorKind: "User",
        clock: { now: () => check(true) },
        transactions: { run: (work) => work(tx) },
        registerBeforeCommit: register,
        authority: {
          async holdUntilTransactionCompletes(actualTx, packet) {
            check(true);
            if (
              actualTx !== tx ||
              packet.tenantReference !== identity.tenantReference ||
              packet.brandReference !== identity.brandReference ||
              packet.actorReference !== identity.actorReference ||
              packet.actorKind !== "User" ||
              packet.purposeCode !== "CATALOG_SELLING_UNIT_REGISTRY" ||
              packet.permission !== "catalog.manage" ||
              packet.action !== "catalog.manage" ||
              packet.mode !== "Read" ||
              JSON.stringify(packet.requiredPermissions) !== JSON.stringify(["catalog.manage"]) ||
              JSON.stringify(packet.requiredFields) !== JSON.stringify(sellingUnitRegistryFields)
            )
              return poison();
            if ((await authorize(Object.freeze(["catalog.manage"]))) !== undefined) return poison();
            check(true);
          },
        },
      });
      let calls = 0;
      if (
        (await source.withRegisteredProductSkuQuantities(request, async (proof, sourceTx) => {
          check();
          if (
            ++calls !== 1 ||
            sourceTx !== tx ||
            proof.sourceAuthority !== "CurrentTransactionHeld" ||
            proof.registry.tenantReference !== identity.tenantReference ||
            proof.registry.brandReference !== identity.brandReference ||
            proof.snapshotDigest !== catalogSellingUnitRegistryDigest(proof.registry) ||
            canonicalizeRfc8785(proof.request) !== canonicalizeRfc8785(request)
          )
            return poison();
          await remainingFields(input);
          originalWrite = Object.freeze({ fingerprint, input, acquired: true });
        })) !== undefined ||
        calls !== 1 ||
        !originalWrite.acquired
      )
        return poison();
      check();
    } catch (error) {
      return reject(error);
    } finally {
      active = false;
    }
  };
}
