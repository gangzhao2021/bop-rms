import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  applyCatalogTaxClassificationChange,
  CatalogError,
  catalogProductTaxClassificationRegistryDigest,
  createPostgresProductTaxClassificationRegistryStore,
  listBrandProducts,
  type CatalogTaxClassificationChange,
  taxClassificationRegistryFields,
  type CatalogProductTaxClassificationRegistry,
  type ProductTaxClassificationRegistryStoreOptions,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { derivedReference } from "./merchant-products.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 Store setup in product: CAT-TAX-CLASSIFICATION-LIST — the Brand Owner adds, renames and
 * retires the Brand's tax classifications and chooses the Brand default, so Store setup fees and
 * products can name one. Classifications are the Owner's own labels ("Prepared food", "Alcohol",
 * "Fees"): no rate, legal treatment or taxability is stated here; rates are set in the tax
 * configuration (Tax review). Every change is one append-only registry version (Catalog owner,
 * audit CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED, event
 * ProductTaxClassificationRegistryVersionRecorded), idempotent by operation reference.
 *
 * Reading needs catalog.manage and catalog.tax-classification.read at Brand scope; changing needs
 * catalog.tax-classification.manage too (Brand Owner, permission catalog v16). One authorized run
 * per transaction: the caller and these decisions are resolved in full once at the start, the
 * registry's own authority checks take the run's guard (no query), and the caller is re-resolved in
 * full once more inside the transaction before it commits.
 */
export class MerchantTaxClassificationError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "Invalid"
      | "NotFound"
      | "NameTaken"
      | "Retired"
      | "Conflict"
      | "Unavailable",
  ) {
    super(code);
    this.name = "MerchantTaxClassificationError";
  }
}
const fail = (code: MerchantTaxClassificationError["code"]): never => {
  throw new MerchantTaxClassificationError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
/** Languages a classification may be named in; the registry's default language is required. */
export const taxClassificationLocales = Object.freeze(["en-CA", "fr-CA"] as const);
const readAction = "catalog.tax-classification.read",
  manageAction = "catalog.tax-classification.manage",
  catalogAction = "catalog.manage";
/** Optional: with it, the page shows which products use each tax class (and classes it lacks). */
const productReadAction = "catalog.product.read";
const actions = Object.freeze([catalogAction, readAction, manageAction, productReadAction]);

export type TaxClassificationNames = Readonly<Record<string, string>>;
export type TaxClassificationCommandBody =
  | {
      readonly action: "Add";
      readonly operationReference: string;
      readonly expectedRegistryVersion: number;
      /** One or more new classifications, each named in the default language (other optional). */
      readonly classifications: readonly { readonly names: TaxClassificationNames }[];
    }
  | {
      readonly action: "Rename";
      readonly operationReference: string;
      readonly expectedRegistryVersion: number;
      readonly classificationReference: string;
      readonly names: TaxClassificationNames;
    }
  | {
      /** `null` clears the Brand default. */
      readonly action: "SetDefault";
      readonly operationReference: string;
      readonly expectedRegistryVersion: number;
      readonly classificationReference: string | null;
    }
  | {
      /** Irreversible: products and fees using it must move to another before their next publication. */
      readonly action: "Retire";
      readonly operationReference: string;
      readonly expectedRegistryVersion: number;
      readonly classificationReference: string;
    };

function names(value: unknown): TaxClassificationNames {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("Invalid");
  const result: Record<string, string> = {};
  for (const [locale, raw] of Object.entries(value)) {
    if (!(taxClassificationLocales as readonly string[]).includes(locale)) return fail("Invalid");
    if (raw === null || raw === "") continue;
    if (typeof raw !== "string" || raw.length > 400) return fail("Invalid");
    const trimmed = raw.trim().replace(/\s+/gu, " ");
    if (trimmed.length > 0) result[locale] = trimmed;
  }
  if (Object.keys(result).length === 0) return fail("Invalid");
  return Object.freeze(result);
}
function version(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 2147483647
    ? (value as number)
    : fail("Invalid");
}
export function parseTaxClassificationCommandBody(value: unknown): TaxClassificationCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (
    r.action === "Add" &&
    keys === "action,classifications,expectedRegistryVersion,operationReference"
  ) {
    if (
      !Array.isArray(r.classifications) ||
      r.classifications.length < 1 ||
      r.classifications.length > 20
    )
      return fail("Invalid");
    return {
      action: "Add",
      operationReference: ref(r.operationReference),
      expectedRegistryVersion: version(r.expectedRegistryVersion),
      classifications: r.classifications.map((entry: unknown) => {
        const e = entry as Record<string, unknown> | null;
        if (e === null || typeof e !== "object" || Object.keys(e).join(",") !== "names")
          return fail("Invalid");
        return { names: names(e.names) };
      }),
    };
  }
  if (
    r.action === "Rename" &&
    keys === "action,classificationReference,expectedRegistryVersion,names,operationReference"
  )
    return {
      action: "Rename",
      operationReference: ref(r.operationReference),
      expectedRegistryVersion: version(r.expectedRegistryVersion),
      classificationReference: ref(r.classificationReference),
      names: names(r.names),
    };
  if (
    (r.action === "SetDefault" || r.action === "Retire") &&
    keys === "action,classificationReference,expectedRegistryVersion,operationReference"
  ) {
    const common = {
      operationReference: ref(r.operationReference),
      expectedRegistryVersion: version(r.expectedRegistryVersion),
    };
    if (r.action === "Retire")
      return {
        action: "Retire",
        ...common,
        classificationReference: ref(r.classificationReference),
      };
    return {
      action: "SetDefault",
      ...common,
      classificationReference:
        r.classificationReference === null ? null : ref(r.classificationReference),
    };
  }
  return fail("Invalid");
}

const reasonCodes = Object.freeze({
  Add: "TAX_CLASSIFICATIONS_ADDED",
  Rename: "TAX_CLASSIFICATION_RENAMED",
  SetDefault: "TAX_CLASSIFICATION_DEFAULT_CHANGED",
  Retire: "TAX_CLASSIFICATION_RETIRED",
} as const);
/** The Catalog change a parsed request asks for (new identities derive from the operation). */
export function taxClassificationChange(
  body: TaxClassificationCommandBody,
): CatalogTaxClassificationChange {
  switch (body.action) {
    case "Add":
      return {
        kind: "Add",
        entries: body.classifications.map((entry, n) => ({
          classificationReference: derivedReference(
            body.operationReference,
            "tax-classification:" + n,
          ),
          localizedNames: entry.names,
        })),
      };
    case "Rename":
      return {
        kind: "Rename",
        classificationReference: body.classificationReference,
        localizedNames: body.names,
      };
    case "SetDefault":
      return { kind: "SetDefault", classificationReference: body.classificationReference };
    case "Retire":
      return { kind: "Retire", classificationReference: body.classificationReference };
  }
}

export interface TaxClassificationView {
  readonly screenId: "CAT-TAX-CLASSIFICATION-LIST";
  readonly sourceAsOf: string;
  readonly permissions: { readonly mayManage: boolean };
  /** 0 before the Brand's first classification. */
  readonly registryVersion: number;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly classifications: readonly {
    readonly classificationReference: string;
    readonly names: TaxClassificationNames;
    readonly lifecycle: "Active" | "Inactive" | "Retired";
    readonly isDefault: boolean;
  }[];
  /**
   * The Brand's products (not archived) by the tax class their draft names, including classes
   * that are not in this registry (a class from the Store's tax configuration) and products with
   * none (null). Null when the viewer may not read products.
   */
  readonly productTaxClasses:
    | readonly {
        readonly classificationReference: string | null;
        readonly productNames: readonly string[];
      }[]
    | null;
}
type ProductTaxClasses = TaxClassificationView["productTaxClasses"];

export function createMerchantTaxClassifications(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const persistence = options.persistence;
  const resolveBrand = options.resolveScope ?? createMerchantBrandScope(persistence);
  type Tx = Parameters<Parameters<typeof persistence.transactions.run>[0]>[0];
  type RegistryTx = Parameters<
    ProductTaxClassificationRegistryStoreOptions["authority"]["holdUntilTransactionCompletes"]
  >[0];
  const now = () => persistence.now();
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  const denied = (): never => fail("PermissionDenied");

  /** The Brand decisions for this page, decided in full (one permission packet). */
  async function decide(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const brand = await resolveBrand(tx, sessionCookie, sessionReference).catch(denied);
    const result = await brand.authorizeActionsWithValidity(actions).catch(denied);
    if (result === null || result.decisions.length !== actions.length) return denied();
    const allowed = new Set<string>();
    result.decisions.forEach((decision, i) => {
      if (
        decision.effect === "Allow" &&
        decision.scopeKind === "Brand" &&
        decision.action === actions[i]
      )
        allowed.add(actions[i] ?? "");
    });
    return Object.freeze({
      scope: Object.freeze({
        tenantReference: String(brand.tenantReference),
        brandReference: String(brand.context.brand.brandReference),
        storeReference: String(brand.selectedStoreReference),
        actorReference: String(brand.actorReference),
      }),
      brandLocale: String(brand.context.brand.defaultLocale),
      allowed,
      validUntil: result.validUntil,
    });
  }
  type Decided = Awaited<ReturnType<typeof decide>>;

  /**
   * One authorized run inside one transaction. `work` receives a registry-store factory whose
   * authority takes the run's guard; every registered pre-COMMIT guard runs before the final full
   * re-check, and every final (synchronous) assertion after it, without yielding before COMMIT.
   */
  async function authorizedRun<T>(
    input: { sessionCookie: unknown; csrf: unknown },
    needsManage: boolean,
    work: (context: {
      decided: Decided;
      productTaxClasses: () => Promise<ProductTaxClasses>;
      registryStore: () => ReturnType<typeof createPostgresProductTaxClassificationRegistryStore>;
      discard: (store: object) => void;
      window: () => { observedAt: string; validUntil: string };
    }) => Promise<T>,
  ): Promise<T> {
    const current = await session(input);
    return retryTransactionConflict(() =>
      persistence.transactions.run(async (tx) => {
        const pending: { owner: object; guard: () => Promise<void>; final: () => void }[] = [];
        const used = new Set<string>([catalogAction, readAction]);
        const value = await withMerchantTransactionAuthorization<Decided, T>(
          {
            transaction: tx,
            resolve: async () => {
              const decided = await decide(tx, input.sessionCookie, current.sessionReference);
              if (!decided.allowed.has(catalogAction) || !decided.allowed.has(readAction))
                return denied();
              if (needsManage && !decided.allowed.has(manageAction)) return denied();
              return decided;
            },
            recheck: async (original) => {
              const again = await decide(tx, input.sessionCookie, current.sessionReference).catch(
                () => null,
              );
              return (
                again !== null &&
                Object.entries(original.scope).every(
                  ([key, value]) => again.scope[key as keyof Decided["scope"]] === value,
                ) &&
                [...used].every((action) => again.allowed.has(action))
              );
            },
            denied,
          },
          async (authority) => {
            const decided = authority.scope;
            const window = () => {
              const observedAt = now();
              const cap = new Date(Date.parse(observedAt) + 25_000).toISOString();
              const validUntil =
                decided.validUntil !== null && decided.validUntil < cap ? decided.validUntil : cap;
              if (validUntil <= observedAt) return denied();
              return { observedAt, validUntil };
            };
            const registryStore = () => {
              const created = createPostgresProductTaxClassificationRegistryStore({
                tenantReference: decided.scope.tenantReference,
                brandReference: decided.scope.brandReference,
                actorReference: decided.scope.actorReference,
                actorKind: "User",
                clock: { now },
                transactions: {
                  run: async <R>(registryWork: (actual: RegistryTx) => Promise<R>) =>
                    registryWork(tx as unknown as RegistryTx),
                },
                authority: {
                  async holdUntilTransactionCompletes(actual, packet) {
                    if (
                      actual !== (tx as unknown) ||
                      packet.tenantReference !== decided.scope.tenantReference ||
                      packet.brandReference !== decided.scope.brandReference ||
                      packet.actorReference !== decided.scope.actorReference ||
                      packet.actorKind !== "User" ||
                      packet.permission !== catalogAction ||
                      packet.purposeCode !== "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY" ||
                      canonicalizeRfc8785(packet.requiredFields) !==
                        canonicalizeRfc8785(taxClassificationRegistryFields) ||
                      !(await authority.guard(tx)) ||
                      !decided.allowed.has(catalogAction) ||
                      !decided.allowed.has(packet.action)
                    )
                      throw new CatalogError("CATALOG_PERMISSION_DENIED");
                    used.add(packet.action);
                  },
                },
                audit: {
                  create: (command) => ({
                    auditId: derivedReference(
                      command.operationReference,
                      "tax-classification-audit",
                    ),
                    brandId: command.brandReference,
                    actor: { type: "User", reference: command.actorReference },
                    actionCode: "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED",
                    targetType: "CatalogTaxClassificationRegistry",
                    targetId: command.registry.registryReference,
                    reasonCode: command.reasonCode,
                    correlationId: command.operationReference,
                    occurredAt: command.occurredAt,
                    sourceChannel: "MERCHANT_WEB",
                    dataClassification: "Internal",
                    retentionPolicyCode: "CATALOG_CONFIGURATION",
                    retentionPolicyVersion: 1,
                  }),
                },
                async registerBeforeCommit(actual, guard, final) {
                  if (actual !== (tx as unknown) || !(await authority.guard(tx)))
                    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
                  pending.push({ owner: created, guard, final });
                },
              });
              return created;
            };
            const productTaxClasses = async (): Promise<ProductTaxClasses> => {
              if (!decided.allowed.has(productReadAction)) return null;
              used.add(productReadAction);
              const groups = new Map<string | null, string[]>();
              for (const product of await listBrandProducts(tx as never, {
                brandReference: decided.scope.brandReference,
              })) {
                if (product.lifecycle === "Archived") continue;
                const names = groups.get(product.taxClassificationReference) ?? [];
                names.push(
                  product.localizedNames[decided.brandLocale] ??
                    Object.values(product.localizedNames)[0] ??
                    "Unnamed product",
                );
                groups.set(product.taxClassificationReference, names);
              }
              return [...groups].map(([classificationReference, productNames]) => ({
                classificationReference,
                productNames,
              }));
            };
            const result = await work({
              decided,
              productTaxClasses,
              registryStore,
              // A read that found no registry registered a guard that can only refuse; it read
              // nothing the reply relies on (the write re-reads the history under its own lock).
              discard: (owner) => {
                for (let i = pending.length - 1; i >= 0; i--)
                  if (pending[i]?.owner === owner) pending.splice(i, 1);
              },
              window,
            });
            for (const entry of pending) await entry.guard();
            return result;
          },
        );
        for (const entry of pending) entry.final();
        return value;
      }),
    );
  }

  const mapCatalog = (error: unknown): never => {
    if (error instanceof MerchantTaxClassificationError) throw error;
    if (error instanceof CatalogError)
      return fail(
        error.code === "CATALOG_PERMISSION_DENIED"
          ? "PermissionDenied"
          : error.code === "CATALOG_VERSION_CONFLICT" ||
              error.code === "CATALOG_IDEMPOTENCY_CONFLICT" ||
              error.code === "CATALOG_LIFECYCLE_CONFLICT"
            ? "Conflict"
            : error.code === "CATALOG_INPUT_INVALID"
              ? "Invalid"
              : "Unavailable",
      );
    throw error;
  };
  /** The current registry, or null before the Brand's first classification. */
  async function currentRegistry(context: Parameters<Parameters<typeof authorizedRun>[2]>[0]) {
    const store = context.registryStore();
    const { observedAt, validUntil } = context.window();
    try {
      return await store.withCurrentRegistry(
        {
          originalIntentDigest:
            "sha256:" +
            sha256Hex(
              canonicalizeRfc8785({
                purpose: "MERCHANT_TAX_CLASSIFICATION_LIST",
                scope: context.decided.scope,
              }),
            ),
          observedAt,
          validUntil,
        },
        async (source) => source.registry,
      );
    } catch (error) {
      if (
        error instanceof CatalogError &&
        error.code === "CATALOG_TAX_CLASSIFICATION_NOT_REGISTERED"
      ) {
        context.discard(store);
        return null;
      }
      throw error;
    }
  }
  const view = (
    registry: CatalogProductTaxClassificationRegistry | null,
    decided: Decided,
    productTaxClasses: ProductTaxClasses,
  ): TaxClassificationView => {
    const defaultLocale = registry?.defaultLocale ?? registryLocale(decided.brandLocale);
    return {
      screenId: "CAT-TAX-CLASSIFICATION-LIST",
      sourceAsOf: now(),
      permissions: { mayManage: decided.allowed.has(manageAction) },
      registryVersion: registry?.registryVersion ?? 0,
      defaultLocale,
      locales: [defaultLocale, ...taxClassificationLocales.filter((l) => l !== defaultLocale)],
      // In use first, then retired; each alphabetically by the default-language name.
      classifications: [...(registry?.definitions ?? [])]
        .sort(
          (a, b) =>
            Number(a.lifecycle === "Retired") - Number(b.lifecycle === "Retired") ||
            (a.localizedNames[defaultLocale] ?? "").localeCompare(
              b.localizedNames[defaultLocale] ?? "",
              defaultLocale,
            ),
        )
        .map((d) => ({
          classificationReference: d.classificationReference,
          names: d.localizedNames,
          lifecycle: d.lifecycle,
          isDefault: registry?.defaultClassificationReference === d.classificationReference,
        })),
      productTaxClasses,
    };
  };

  async function query(input: { sessionCookie: unknown; csrf: unknown }) {
    try {
      return await authorizedRun(input, false, async (context) => {
        const registry = await currentRegistry(context);
        return view(registry, context.decided, await context.productTaxClasses());
      });
    } catch (error) {
      return mapCatalog(error);
    }
  }

  async function command(input: { sessionCookie: unknown; csrf: unknown; body: unknown }) {
    const body = parseTaxClassificationCommandBody(input.body);
    const bodyDigest = sha256Hex(canonicalizeRfc8785(body));
    try {
      return await authorizedRun(input, true, async (context) => {
        const { decided } = context;
        const current = await currentRegistry(context);
        // Read before the change is recorded: products do not change with the registry.
        const productTaxClasses = await context.productTaxClasses();
        const versionReference = derivedReference(
          body.operationReference,
          "tax-classification-version:" + bodyDigest,
        );
        const base = {
          purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
          tenantReference: decided.scope.tenantReference,
          brandReference: decided.scope.brandReference,
          actorReference: decided.scope.actorReference,
          actorKind: "User",
          operationReference: body.operationReference,
          reasonCode: reasonCodes[body.action],
        } as const;
        let commandValue: Record<string, unknown>;
        if (current !== null && current.versionReference === versionReference) {
          // A retry of the change already recorded as the current version: the owner replays it
          // (and refuses it as a conflict if another person sent the same operation).
          commandValue = {
            ...base,
            expectedRegistryVersion: current.registryVersion - 1,
            occurredAt: current.registeredAt,
            registry: current,
          };
        } else {
          if ((current?.registryVersion ?? 0) !== body.expectedRegistryVersion) fail("Conflict");
          const occurredAt = now();
          if (current !== null && occurredAt < current.registeredAt) fail("Unavailable");
          const defaultLocale = current?.defaultLocale ?? registryLocale(decided.brandLocale);
          commandValue = {
            ...base,
            expectedRegistryVersion: body.expectedRegistryVersion,
            occurredAt,
            registry: {
              profile: "CatalogProductTaxClassificationRegistryV1",
              tenantReference: decided.scope.tenantReference,
              brandReference: decided.scope.brandReference,
              registryReference:
                current?.registryReference ??
                derivedReference(body.operationReference, "tax-classification-registry"),
              versionReference,
              registryVersion: body.expectedRegistryVersion + 1,
              defaultLocale,
              previousSnapshotDigest:
                current === null ? null : catalogProductTaxClassificationRegistryDigest(current),
              registeredAt: occurredAt,
              ...changed(current, defaultLocale, body),
            },
          };
        }
        const result = await context.registryStore().execute(commandValue);
        return {
          status: result.status,
          view: view(result.registry, decided, productTaxClasses),
        };
      });
    } catch (error) {
      return mapCatalog(error);
    }
  }
  return Object.freeze({ query, command });
}
function changed(
  current: CatalogProductTaxClassificationRegistry | null,
  defaultLocale: string,
  body: TaxClassificationCommandBody,
) {
  const change = taxClassificationChange(body);
  // An operation reference already used for an earlier change (its new identities exist): a
  // changed intent under a used operation is a conflict, never a second change.
  if (
    change.kind === "Add" &&
    change.entries.some((entry) =>
      current?.definitions.some((d) => d.classificationReference === entry.classificationReference),
    )
  )
    return fail("Conflict");
  const result = applyCatalogTaxClassificationChange(current, defaultLocale, change);
  if (!result.ok) return fail(result.reason);
  return {
    definitions: result.definitions,
    defaultClassificationReference: result.defaultClassificationReference,
  };
}
/** The registry's default language: the Brand's, when classifications can be named in it. */
function registryLocale(brandLocale: string): string {
  return (taxClassificationLocales as readonly string[]).includes(brandLocale)
    ? brandLocale
    : "en-CA";
}
