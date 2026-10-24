import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  frozenFullOptionSetContentFields,
  type FrozenFullOptionSetContentAuthority,
  parseCatalogFullOptionSetPublicationContent,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type OptionAuthority = FrozenFullOptionSetContentAuthority;

/** Native admission is separate from the owning frozen Option and independent field policy.
 * Receipt reads check current permission without replacing original frozen Option. */
export function createMerchantProductFrozenOptionAuthority(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly transaction: ProductLifecycleTransaction;
  readonly sessionCookie: unknown;
  readonly sessionReference: string;
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
  };
  readonly authority: OptionAuthority;
}) {
  const fail = (
    code:
      | "CATALOG_DEPENDENCY_UNAVAILABLE"
      | "CATALOG_PERMISSION_DENIED" = "CATALOG_DEPENDENCY_UNAVAILABLE",
  ): never => {
    throw new CatalogError(code);
  };
  if (
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.transaction?.query !== "function"
  )
    return fail();
  const rawScope = readClosedRecord(copyCategoryPersistenceValue(options.scope), [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
  ]);
  const expected = Object.freeze({
    tenantReference: parseCatalogReference(rawScope.tenantReference),
    brandReference: parseCatalogReference(rawScope.brandReference),
    storeReference: parseCatalogReference(rawScope.storeReference),
    actorReference: parseCatalogReference(rawScope.actorReference),
  });
  const tx = options.transaction,
    query = tx.query,
    session = parseCatalogReference(options.sessionReference),
    cookie = options.sessionCookie,
    now = options.merchant.now.bind(options.merchant),
    resolve = createMerchantBrandScope(options.merchant),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    observedAt = parseCatalogInstant(now()),
    validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
  let deadline = validUntil,
    latest = observedAt,
    failed = false,
    active = false;
  const check = () => {
    const at = parseCatalogInstant(now());
    if (failed || tx.query !== query || at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  };
  const permission = async () => {
    check();
    const current = await resolve(tx, cookie, session);
    check();
    if (
      current.tenantReference !== expected.tenantReference ||
      String(current.context.brand.brandReference) !== expected.brandReference ||
      String(current.selectedStoreReference) !== expected.storeReference ||
      String(current.actorReference) !== expected.actorReference
    )
      return fail("CATALOG_PERMISSION_DENIED");
    for (const action of ["catalog.manage", "catalog.option_set.read"]) {
      const decision = await current.authorizeAction(action);
      check();
      if (
        decision?.effect !== "Allow" ||
        decision.scopeKind !== "Brand" ||
        decision.action !== action
      )
        return fail("CATALOG_PERMISSION_DENIED");
    }
  };
  const assertCurrent = async (actual: ProductLifecycleTransaction): Promise<void> => {
    try {
      if (actual !== tx || active) return fail();
      active = true;
      await permission();
      check();
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  const authority: OptionAuthority = Object.freeze({
    async holdUntilTransactionCompletes(
      actual: ProductLifecycleTransaction,
      value: Parameters<OptionAuthority["holdUntilTransactionCompletes"]>[1],
    ) {
      try {
        if (actual !== tx || active) return fail();
        active = true;
        check();
        const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "actorReference",
          "actorKind",
          "purposeCode",
          "permission",
          "action",
          "optionSetReference",
          "versionReference",
          "content",
          "requiredFields",
          "observedAt",
        ]);
        const at = parseCatalogInstant(raw.observedAt),
          optionSetReference = parseCatalogReference(raw.optionSetReference),
          versionReference = parseCatalogReference(raw.versionReference),
          content =
            raw.content === null ? null : parseCatalogFullOptionSetPublicationContent(raw.content);
        if (
          raw.tenantReference !== expected.tenantReference ||
          raw.brandReference !== expected.brandReference ||
          raw.actorReference !== expected.actorReference
        )
          return fail("CATALOG_PERMISSION_DENIED");
        if (
          raw.actorKind !== "User" ||
          raw.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT" ||
          raw.permission !== "catalog.manage" ||
          raw.action !== "catalog.option_set.read" ||
          JSON.stringify(raw.requiredFields) !== JSON.stringify(frozenFullOptionSetContentFields) ||
          at < observedAt ||
          at > check() ||
          (content !== null &&
            (content.supportedContent.tenantReference !== expected.tenantReference ||
              content.supportedContent.brandReference !== expected.brandReference ||
              content.supportedContent.optionSetReference !== optionSetReference ||
              content.supportedContent.versionReference !== versionReference ||
              content.supportedContent.sealedAt > at))
        )
          return fail();
        const input = Object.freeze({
          tenantReference: expected.tenantReference,
          brandReference: expected.brandReference,
          actorReference: expected.actorReference,
          actorKind: "User" as const,
          purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT" as const,
          permission: "catalog.manage" as const,
          action: "catalog.option_set.read" as const,
          optionSetReference,
          versionReference,
          content,
          requiredFields: frozenFullOptionSetContentFields,
          observedAt: at,
        });
        await permission();
        const held = readClosedRecord(copyCategoryPersistenceValue(await hold(tx, input)), [
            "observedAt",
            "validUntil",
          ]),
          heldAt = parseCatalogInstant(held.observedAt),
          until = parseCatalogInstant(held.validUntil);
        if (heldAt !== at || until <= heldAt || Date.parse(until) - Date.parse(heldAt) > 30000)
          return fail();
        check();
        await permission();
        const current = check();
        deadline = until < deadline ? until : deadline;
        if (current >= deadline) return fail();
        return Object.freeze({ observedAt: heldAt, validUntil: deadline });
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        active = false;
      }
    },
  });
  return Object.freeze({ authority, assertCurrent });
}
