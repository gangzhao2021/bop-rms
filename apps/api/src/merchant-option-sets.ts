import { createHash } from "node:crypto";
import {
  CatalogError,
  createCatalogProductService,
  createOptionSetService,
  createPostgresProductCreationStore,
  createPostgresProductDraftStore,
  optionBindingDefaultRules,
  productOptionBindingRule,
  rebuiltProductOptionBinding,
  createPostgresOptionSetRepository,
  listBrandOptionSets,
  listBrandProducts,
  loadBrandProduct,
  parseCatalogHash,
  parseCatalogReference,
  type OptionSetAggregate,
  type ProductAggregate,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { derivedReference } from "./merchant-products.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { chineseOf, optionalChinese, withChinese } from "./merchant-chinese-text.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { staffContentName } from "./staff-content-locale.js";
import { onlyRefusal } from "./merchant-failure.js";

/**
 * WP-2423 slice 4: CAT-OPTIONSET-LIST / CAT-OPTIONSET-EDIT for the selected Store's Brand — choices
 * customers make on an item (milk, extra shot). A set is "choose one", "choose any" or "choose a
 * quantity" with its limits; each option can be offered or not offered. Options are never deleted
 * (orders refer to them). Changes reach customers when a menu that uses the set is next published;
 * an option that stops being offered cannot be ordered from then on.
 */
export class MerchantOptionSetError extends Error {
  constructor(
    readonly code: "PermissionDenied" | "NotFound" | "Conflict" | "Invalid" | "OptionSet",
    /**
     * WP-2423 (cart-unsellable-dishes), with "OptionSet": the change would leave these dishes
     * without a choice guests start with in a group they must choose in (`DefaultNeeded`), or it
     * moves what they start with and this person may not edit dishes
     * (`DefaultChangeNeedsDishEditor`). Nothing was saved.
     */
    readonly problem: {
      readonly reason: "DefaultNeeded" | "DefaultChangeNeedsDishEditor";
      readonly optionName: string;
      readonly productNames: readonly string[];
    } | null = null,
  ) {
    super(code);
    this.name = "MerchantOptionSetError";
  }
}
const fail = (code: MerchantOptionSetError["code"]): never => {
  throw new MerchantOptionSetError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string") return fail("Invalid");
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : fail("Invalid");
};
const count = (value: unknown, min: number, max: number): number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : fail("Invalid");
const codePattern = /^[A-Z][A-Z0-9_-]{0,63}$/u;
/** A stable code from a name: letters and digits in upper case joined by "_". */
export const codeFromName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/[^A-Za-z0-9_]/gu, "")
    .replace(/^[^A-Za-z]+|_+$/gu, "")
    .toUpperCase()
    .slice(0, 64);

/** The code for a name; names without Latin letters (e.g. 燕麦奶) get a code from their digest. */
export const codeForName = (name: string, prefix: string) => {
  const code = codeFromName(name);
  return codePattern.test(code)
    ? code
    : prefix + "_" + createHash("sha256").update(name).digest("hex").slice(0, 8).toUpperCase();
};

export type OptionChoiceKind = "One" | "Any" | "Quantity";
export interface OptionSetBody {
  readonly name: string;
  /** Owner 2026-10-23: the set's Simplified Chinese name ("" clears it; absent keeps it). */
  readonly nameZh?: string;
  readonly kind: OptionChoiceKind;
  /** Customers must choose at least this many (0 = optional). */
  readonly minimum: number;
  /** At most this many choices in total (null = no limit; "One" is always 1). */
  readonly maximum: number | null;
  /** "Quantity": how many of one option a customer may choose. */
  readonly perOptionMaximum: number;
  readonly options: readonly {
    readonly optionReference: string | null;
    readonly name: string;
    readonly nameZh?: string;
    readonly offered: boolean;
    readonly defaultChoice: boolean;
  }[];
}
export type OptionSetCommandBody =
  | ({
      readonly action: "Create";
      readonly operationReference: string;
      /**
       * WP-2423 item 8 ⑥ part 4: a fixed code (a combo slot's set, whose name, e.g. 汤, other
       * combos share); absent: the code comes from the name.
       */
      readonly internalCode?: string;
    } & OptionSetBody)
  | ({
      readonly action: "Save";
      readonly operationReference: string;
      readonly optionSetReference: string;
      readonly expectedAggregateVersion: number;
    } & OptionSetBody)
  | {
      readonly action: "Archive";
      readonly operationReference: string;
      readonly optionSetReference: string;
      readonly expectedAggregateVersion: number;
    };
const bodyKeys = ["kind", "maximum", "minimum", "name", "options", "perOptionMaximum"];
const keysOf = (...keys: string[]) => keys.sort().join(",");
function parseBody(r: Record<string, unknown>): OptionSetBody {
  const kind = r.kind;
  if (kind !== "One" && kind !== "Any" && kind !== "Quantity") return fail("Invalid");
  if (!Array.isArray(r.options) || r.options.length < 1 || r.options.length > 50)
    return fail("Invalid");
  const options = r.options.map((candidate: unknown) => {
    const o = candidate as Record<string, unknown> | null;
    if (
      o === null ||
      typeof o !== "object" ||
      Object.keys(o)
        .filter((key) => key !== "nameZh")
        .sort()
        .join(",") !== "defaultChoice,name,offered,optionReference" ||
      typeof o.offered !== "boolean" ||
      typeof o.defaultChoice !== "boolean"
    )
      return fail("Invalid");
    const nameZh = optionalChinese(o.nameZh, 80, () => fail("Invalid"));
    return {
      optionReference: o.optionReference === null ? null : ref(o.optionReference),
      name: text(o.name, 80),
      ...(nameZh === undefined ? {} : { nameZh }),
      offered: o.offered,
      defaultChoice: o.defaultChoice,
    };
  });
  const names = options.map((o) => o.name.toLowerCase());
  if (new Set(names).size !== names.length) return fail("Invalid");
  const minimum = count(r.minimum, 0, 20);
  const maximum = r.maximum === null ? null : count(r.maximum, 1, 50);
  const perOptionMaximum = kind === "Quantity" ? count(r.perOptionMaximum, 1, 20) : 1;
  if (kind === "One" && (maximum !== 1 || minimum > 1)) return fail("Invalid");
  if (maximum !== null && maximum < minimum) return fail("Invalid");
  if (minimum > options.filter((o) => o.offered).length * perOptionMaximum) return fail("Invalid");
  if (kind === "One" && options.filter((o) => o.defaultChoice).length > 1) return fail("Invalid");
  const nameZh = optionalChinese(r.nameZh, 80, () => fail("Invalid"));
  return {
    name: text(r.name, 80),
    ...(nameZh === undefined ? {} : { nameZh }),
    kind,
    minimum,
    maximum,
    perOptionMaximum,
    options,
  };
}
export function parseOptionSetCommandBody(value: unknown): OptionSetCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r)
    .filter((key) => key !== "nameZh" && !(r.action === "Create" && key === "internalCode"))
    .sort()
    .join(",");
  if (r.action === "Create" && keys === keysOf("action", "operationReference", ...bodyKeys)) {
    if (
      r.internalCode !== undefined &&
      (typeof r.internalCode !== "string" || !codePattern.test(r.internalCode))
    )
      return fail("Invalid");
    return {
      action: "Create",
      operationReference: ref(r.operationReference),
      ...(r.internalCode === undefined ? {} : { internalCode: r.internalCode }),
      ...parseBody(r),
    };
  }
  if (
    r.action === "Save" &&
    keys ===
      keysOf(
        "action",
        "expectedAggregateVersion",
        "operationReference",
        "optionSetReference",
        ...bodyKeys,
      )
  )
    return {
      action: "Save",
      operationReference: ref(r.operationReference),
      optionSetReference: ref(r.optionSetReference),
      expectedAggregateVersion: count(r.expectedAggregateVersion, 1, Number.MAX_SAFE_INTEGER),
      ...parseBody(r),
    };
  if (
    r.action === "Archive" &&
    keys === "action,expectedAggregateVersion,operationReference,optionSetReference"
  )
    return {
      action: "Archive",
      operationReference: ref(r.operationReference),
      optionSetReference: ref(r.optionSetReference),
      expectedAggregateVersion: count(r.expectedAggregateVersion, 1, Number.MAX_SAFE_INTEGER),
    };
  return fail("Invalid");
}

const kindOf = (style: string): OptionChoiceKind =>
  style === "SingleChoice" ? "One" : style === "MultiChoice" ? "Any" : "Quantity";
const styleOf = (kind: OptionChoiceKind) =>
  kind === "One" ? "SingleChoice" : kind === "Any" ? "MultiChoice" : "Quantity";
const catalogErrors: Partial<Record<CatalogError["code"], MerchantOptionSetError["code"]>> = {
  CATALOG_PERMISSION_DENIED: "PermissionDenied",
  CATALOG_VERSION_CONFLICT: "Conflict",
  CATALOG_IDEMPOTENCY_CONFLICT: "Conflict",
  CATALOG_LIFECYCLE_CONFLICT: "Conflict",
  CATALOG_UNAVAILABLE: "NotFound",
  CATALOG_INPUT_INVALID: "Invalid",
  CATALOG_CODE_CONFLICT: "Invalid",
};

export function createMerchantOptionSets(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const ptx = (tx: unknown) => tx as ProductLifecycleTransaction;
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(onlyRefusal(() => fail("PermissionDenied")));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(
      onlyRefusal(() => fail("PermissionDenied")),
    );
    const decision = (action: string) => scope.authorizeAction(action);
    const mayRead = (await decision("catalog.option_set.read"))?.effect === "Allow";
    if (!mayRead) fail("PermissionDenied");
    const mayEdit = (await decision("catalog.option_set.manage"))?.effect === "Allow";
    return {
      scope,
      decision,
      brand: String(scope.context.brand.brandReference),
      actor: String(scope.actorReference),
      permissions: { mayEdit },
    };
  }
  type Scope = Awaited<ReturnType<typeof scopeFor>>;
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;
  /**
   * The Brand's products (not archived) whose draft offers each option set, by name: a set no
   * product uses cannot reach customers, so staff are not told it is "in use".
   */
  async function usage(tx: unknown, brand: string): Promise<Usage> {
    const used: Usage = new Map();
    for (const product of await dishes(tx, brand)) {
      const productName = dishName(product);
      for (const binding of product.draft.optionBindings) {
        const names = used.get(String(binding.optionSetReference)) ?? [];
        if (!names.includes(productName)) names.push(productName);
        used.set(String(binding.optionSetReference), names);
        // WP-2423 (cart-unsellable-dishes): which dishes start guests with each option.
        for (const start of binding.defaultSelections) {
          const key = "starts:" + String(start.optionReference);
          const starting = used.get(key) ?? [];
          if (!starting.includes(productName)) starting.push(productName);
          used.set(key, starting);
        }
      }
    }
    return used;
  }
  /** The Brand's dishes that are not archived, as their drafts stand now. */
  async function dishes(tx: unknown, brand: string): Promise<ProductAggregate[]> {
    const found: ProductAggregate[] = [];
    for (const summary of await listBrandProducts(ptx(tx) as never, { brandReference: brand })) {
      if (summary.lifecycle === "Archived") continue;
      const product = await loadBrandProduct(
        ptx(tx) as never,
        { brandReference: brand },
        summary.productReference,
      );
      if (product !== null) found.push(product);
    }
    return found;
  }
  const dishName = (product: ProductAggregate) =>
    staffContentName(product.draft.localizedNames, options.locale) || product.internalCode;
  type Usage = Map<string, string[]>;
  const view = (set: OptionSetAggregate, used: ReadonlyMap<string, readonly string[]>) => ({
    optionSetReference: set.optionSetReference,
    internalCode: set.internalCode,
    aggregateVersion: set.aggregateVersion,
    archived: set.lifecycle === "Archived",
    /** Products whose draft offers this set (customers see it once such a menu is published). */
    productNames: used.get(String(set.optionSetReference)) ?? [],
    name: name(set.draft.localizedNames, set.internalCode),
    nameZh: chineseOf(set.draft.localizedNames),
    kind: kindOf(set.draft.displayStyle),
    minimum: set.draft.minimumSelection,
    maximum: set.draft.maximumSelection,
    perOptionMaximum: set.draft.perOptionMaximumQuantity,
    updatedAt: set.updatedAt,
    options: set.draft.options
      .filter((option) => option.lifecycle !== "Archived")
      .map((option) => ({
        optionReference: option.optionReference,
        code: option.stableCode,
        name: name(option.localizedNames, option.stableCode),
        nameZh: chineseOf(option.localizedNames),
        offered: option.lifecycle === "Active",
        defaultChoice: option.defaultEligible,
        /** WP-2423 (cart-unsellable-dishes): dishes whose draft starts guests with this option. */
        startsOn: used.get("starts:" + String(option.optionReference)) ?? [],
      })),
  });

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    optionSetReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          const sets = await listBrandOptionSets(ptx(tx), { brandReference: s.brand });
          const base = {
            sourceAsOf: options.persistence.now(),
            permissions: s.permissions,
          };
          const used = await usage(tx, s.brand);
          if (input.optionSetReference === null)
            return {
              screenId: "CAT-OPTIONSET-LIST" as const,
              ...base,
              optionSets: sets.map((set) => view(set, used)),
            };
          const set = sets.find(
            (candidate) => candidate.optionSetReference === input.optionSetReference,
          );
          if (set === undefined) return fail("NotFound");
          return { screenId: "CAT-OPTIONSET-EDIT" as const, ...base, optionSet: view(set, used) };
        }),
      ),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseOptionSetCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          if (!s.permissions.mayEdit) fail("PermissionDenied");
          const at = options.persistence.now();
          const service = optionSetService(tx, s, body.operationReference);
          // A retried submission (same operation) returns what it did the first time; the domain
          // intent includes the request time, so it cannot be re-sent through the service.
          const prior = await optionSetRepository(tx, s).resolveOperation(
            parseCatalogReference(body.operationReference),
          );
          if (prior !== null) {
            const record = prior as { action: string; aggregate: OptionSetAggregate };
            const action = body.action === "Save" ? "ReplaceDraft" : body.action;
            if (
              record.action !== action ||
              (body.action !== "Create" &&
                record.aggregate.optionSetReference !== body.optionSetReference) ||
              record.aggregate.brandReference !== s.brand
            )
              return fail("Conflict");
            return {
              status: "AlreadyApplied" as const,
              optionSet: view(record.aggregate, await usage(tx, s.brand)),
            };
          }
          try {
            if (body.action === "Create") {
              const code = body.internalCode ?? codeForName(body.name, "SET");
              const result = await service.create({
                internalCode: code,
                defaultLocale: options.locale,
                localizedNames: withChinese({ [options.locale]: body.name }, body.nameZh),
                localizedDescriptions: {},
                ...limits(body),
                // New options: the service assigns their identity.
                options: optionInputs(body, []).map((option) =>
                  Object.fromEntries(
                    Object.entries(option).filter(([key]) => key !== "optionReference"),
                  ),
                ),
                operationReference: body.operationReference,
                requestedAt: at,
              });
              return {
                status: result.status,
                optionSet: view(result.aggregate, await usage(tx, s.brand)),
              };
            }
            const sets = await listBrandOptionSets(ptx(tx), { brandReference: s.brand });
            const existing = sets.find((set) => set.optionSetReference === body.optionSetReference);
            if (existing === undefined) return fail("NotFound");
            if (body.action === "Archive") {
              const result = await service.archive({
                optionSetReference: body.optionSetReference,
                expectedAggregateVersion: body.expectedAggregateVersion,
                operationReference: body.operationReference,
                requestedAt: at,
              });
              return {
                status: result.status,
                optionSet: view(result.aggregate, await usage(tx, s.brand)),
              };
            }
            const priorOptions = existing.draft.options;
            const kept = optionInputs(body, priorOptions);
            // Options no longer listed stay on record, not offered (orders refer to them).
            const dropped = priorOptions.filter(
              (option) => !body.options.some((o) => o.optionReference === option.optionReference),
            );
            const merged = [
              ...kept,
              ...dropped.map((option) => ({ ...option, lifecycle: "Inactive" as const })),
            ].map((option, sortOrder) => ({ ...option, sortOrder }));
            const draft = {
              ...existing.draft,
              localizedNames: withChinese(
                { ...existing.draft.localizedNames, [options.locale]: body.name },
                body.nameZh,
              ),
              ...limits(body),
              options: merged.map((option) =>
                "optionReference" in option && option.optionReference !== null
                  ? {
                      ...option,
                      conflictOptionReferences: [...option.conflictOptionReferences].sort(),
                    }
                  : {
                      ...option,
                      optionReference: parseCatalogReference(
                        derivedReference(body.operationReference, "option:" + option.stableCode),
                      ),
                      optionSetReference: existing.optionSetReference,
                      brandReference: existing.brandReference,
                      createdAt: at,
                      createdByActorReference: s.actor,
                    },
              ),
              updatedAt: at,
            };
            // WP-2423 (cart-unsellable-dishes): what this Save does to the dishes using the set.
            const effect = await defaultEffect(
              tx,
              s,
              existing,
              draft as unknown as OptionSetAggregate["draft"],
            );
            const result = await service.replaceDraft({
              optionSetReference: body.optionSetReference,
              expectedAggregateVersion: body.expectedAggregateVersion,
              draft,
              operationReference: body.operationReference,
              requestedAt: at,
            });
            const carried = await carryDefaults(tx, s, effect.moves, body.operationReference, at);
            return {
              status: result.status,
              optionSet: view(result.aggregate, await usage(tx, s.brand)),
              defaultsCarried: carried,
              notOfferedDefaults: effect.notOffered,
            };
          } catch (error) {
            if (error instanceof MerchantOptionSetError) throw error;
            const mapped = error instanceof CatalogError ? catalogErrors[error.code] : undefined;
            if (mapped !== undefined) return fail(mapped);
            throw error;
          }
        }),
      ),
    );
  };

  /**
   * WP-2423 (cart-unsellable-dishes): what saving `draft` over `existing` does to each dish whose
   * draft uses the set. A dish's start choices are those the set's default-eligible choices give
   * it (ordered by the set, offered or not); only a change between the set as it is and as
   * proposed moves them, so a dish whose stored defaults differ for another reason (older per-dish
   * defaults) is never rewritten by an unrelated Save, and turning a choice off moves nothing.
   * Refused before anything is written: a dish that would be left with no start choice in a group
   * guests must choose in, or a move by someone who may not edit dishes.
   */
  async function defaultEffect(
    tx: Tx,
    s: Scope,
    existing: OptionSetAggregate,
    draft: OptionSetAggregate["draft"],
  ) {
    const proposed = { ...existing, draft } as OptionSetAggregate;
    const setName = name(draft.localizedNames, existing.internalCode);
    const moves: {
      product: ProductAggregate;
      productName: string;
      bindings: ProductAggregate["draft"]["optionBindings"];
      startsWith: string | null;
    }[] = [];
    const needed: string[] = [];
    const notOffered = new Map<string, string[]>();
    const starts = (selections: readonly { optionReference: string; quantity: number }[]) =>
      selections
        .map((item) => item.optionReference + "×" + item.quantity)
        .sort()
        .join(",");
    for (const product of await dishes(tx, s.brand)) {
      const productName = dishName(product);
      let changed = false;
      let startsWith: string | null = null;
      const bindings = product.draft.optionBindings.map((binding) => {
        if (binding.optionSetReference !== existing.optionSetReference) return binding;
        // A choice that goes off now while this dish starts with it: say so (nothing moves).
        for (const start of binding.defaultSelections) {
          const option = draft.options.find((o) => o.optionReference === start.optionReference);
          const before = existing.draft.options.find(
            (o) => o.optionReference === start.optionReference,
          );
          if (option?.lifecycle === "Inactive" && before?.lifecycle !== "Inactive") {
            const optionName = name(option.localizedNames, option.stableCode);
            const list = notOffered.get(optionName) ?? [];
            if (!list.includes(productName)) list.push(productName);
            notOffered.set(optionName, list);
          }
        }
        const order = { offeredFirst: false };
        const now = rebuiltProductOptionBinding(binding, existing, order);
        const next = rebuiltProductOptionBinding(binding, proposed, order);
        if (starts(now.defaultSelections) === starts(next.defaultSelections)) return binding;
        const carried = { ...binding, defaultSelections: next.defaultSelections };
        const rule = productOptionBindingRule(carried, proposed, "Draft");
        if (rule !== null && optionBindingDefaultRules.has(rule)) {
          if (!needed.includes(productName)) needed.push(productName);
          return binding;
        }
        changed = true;
        const first = draft.options.find(
          (o) => o.optionReference === next.defaultSelections[0]?.optionReference,
        );
        startsWith = first === undefined ? null : name(first.localizedNames, first.stableCode);
        return carried;
      });
      if (changed) moves.push({ product, productName, bindings, startsWith });
    }
    if (needed.length > 0)
      throw new MerchantOptionSetError("OptionSet", {
        reason: "DefaultNeeded",
        optionName: setName,
        productNames: needed,
      });
    if (moves.length > 0 && (await s.decision("catalog.product.manage"))?.effect !== "Allow")
      throw new MerchantOptionSetError("OptionSet", {
        reason: "DefaultChangeNeedsDishEditor",
        optionName: setName,
        productNames: moves.map((move) => move.productName),
      });
    return {
      moves,
      notOffered: [...notOffered].map(([optionName, productNames]) => ({
        optionName,
        productNames,
      })),
    };
  }
  /**
   * Each moved dish's draft, saved as Save dish saves it (the product's own command, audit row and
   * version), correlated to this Save. Guests see the new start choice once the menu is listed.
   */
  async function carryDefaults(
    tx: Tx,
    s: Scope,
    moves: Awaited<ReturnType<typeof defaultEffect>>["moves"],
    operation: string,
    at: string,
  ) {
    const carried: { productName: string; startsWith: string | null }[] = [];
    const productTx = ptx(tx);
    const storeOptions = {
      brandReference: s.brand,
      transactions: {
        run: <T>(work: (t: ProductLifecycleTransaction) => Promise<T>) => work(productTx),
      },
      authorize: async () => true,
    };
    const creation = createPostgresProductCreationStore(storeOptions);
    const drafts = createPostgresProductDraftStore(storeOptions);
    for (const move of moves) {
      const step = derivedReference(operation, "default-carry:" + move.product.productReference);
      const generated: Record<string, number> = {};
      const service = createCatalogProductService({
        repository: {
          resolveOperation: creation.resolveOperation,
          load: creation.load,
          codeAvailable: creation.codeAvailable,
          create: creation.create,
          commit: (value) => drafts.commit(value as never),
        },
        optionSets: {
          resolveVersion: async (request) => {
            if (request.brandReference !== s.brand) return null;
            const sets = await listBrandOptionSets(productTx, { brandReference: s.brand });
            return (
              sets.find(
                (set) =>
                  set.optionSetReference === request.optionSetReference &&
                  set.draft.versionReference === request.optionSetVersionReference,
              ) ?? null
            );
          },
        },
        references: {
          generate: (purpose) => {
            const index = generated[purpose] ?? 0;
            generated[purpose] = index + 1;
            return derivedReference(step, purpose + ":" + index);
          },
          hashIntent: (value) => parseCatalogHash(createHash("sha256").update(value).digest("hex")),
          equals: (a, b) => a === b,
        },
        authorization: {
          authorize: async (request) => {
            const permission = await s.decision("catalog.product.manage");
            if (permission?.effect !== "Allow" || request.operationReference !== step) return null;
            return {
              tenantContext: s.scope.context,
              permission,
              audit: {
                auditId: derivedReference(step, "audit"),
                brandId: s.brand,
                actor: { type: "User", reference: s.actor },
                actionCode: "CATALOG_PRODUCT_REPLACEDRAFT",
                targetType: "CatalogProduct",
                targetId: request.productReference ?? "",
                correlationId: operation,
                occurredAt: request.observedAt,
                reasonCode: "OPTION_SET_DEFAULT_CARRIED",
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              },
            } as never;
          },
        },
      });
      await service.replaceDraft({
        productReference: move.product.productReference,
        expectedAggregateVersion: move.product.aggregateVersion,
        operationReference: step,
        requestedAt: at,
        draft: { ...move.product.draft, optionBindings: move.bindings, updatedAt: at },
      });
      carried.push({ productName: move.productName, startsWith: move.startsWith });
    }
    return carried;
  }

  const limits = (body: OptionSetBody) => ({
    displayStyle: styleOf(body.kind),
    minimumSelection: body.minimum,
    maximumSelection: body.kind === "One" ? 1 : body.maximum,
    allowRepeatedOption: body.kind === "Quantity" && body.perOptionMaximum > 1,
    perOptionMaximumQuantity: body.kind === "Quantity" ? body.perOptionMaximum : 1,
    maximumTotalQuantity: body.kind === "Quantity" ? body.maximum : null,
  });
  /** The listed options, in order, keeping the identity and history of existing ones. */
  function optionInputs(body: OptionSetBody, prior: OptionSetAggregate["draft"]["options"]) {
    const used = new Set<string>(prior.map((option) => String(option.stableCode)));
    return body.options.map((option, sortOrder) => {
      const existing =
        option.optionReference === null
          ? undefined
          : prior.find((candidate) => candidate.optionReference === option.optionReference);
      if (option.optionReference !== null && existing === undefined) fail("Invalid");
      const lifecycle = option.offered ? ("Active" as const) : ("Inactive" as const);
      if (existing !== undefined)
        return {
          ...existing,
          lifecycle,
          localizedNames: withChinese(
            { ...existing.localizedNames, [options.locale]: option.name },
            option.nameZh,
          ),
          sortOrder,
          defaultEligible: option.defaultChoice,
        };
      const base = codeForName(option.name, "OPTION").slice(0, 60);
      let stableCode = base;
      for (let n = 2; used.has(stableCode); n++) stableCode = base + "_" + n;
      used.add(stableCode);
      return {
        optionReference: null,
        stableCode,
        lifecycle,
        localizedNames: withChinese({ [options.locale]: option.name }, option.nameZh),
        localizedDescriptions: {},
        sortOrder,
        defaultEligible: option.defaultChoice,
        triggeredOptionSetReference: null,
        conflictOptionReferences: [],
      };
    });
  }

  /** The Catalog Option Set service with the Brand authority for this operation. */
  function optionSetService(tx: Tx, s: Scope, operation: string) {
    const generated: Record<string, number> = {};
    return createOptionSetService({
      authorization: {
        authorize: async (request) => {
          const decision = await s.decision("catalog.option_set.manage");
          if (decision?.effect !== "Allow") return null;
          return {
            tenantContext: s.scope.context,
            permission: decision,
            audit: {
              auditId: derivedReference(operation, "audit:" + request.action),
              brandId: s.brand,
              actor: { type: "User", reference: s.actor },
              actionCode: "CATALOG_OPTION_SET_" + request.action.toUpperCase(),
              targetType: "CatalogOptionSet",
              targetId: request.optionSetReference,
              correlationId: operation,
              occurredAt: request.observedAt,
              reasonCode: "AUTHORIZED_OPERATION",
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Internal",
              retentionPolicyCode: "CONFIGURATION_AUDIT",
              retentionPolicyVersion: 1,
            },
          } as never;
        },
      },
      references: {
        generate: (purpose) => {
          const index = generated[purpose] ?? 0;
          generated[purpose] = index + 1;
          return derivedReference(operation, purpose + ":" + index);
        },
        hashIntent: (value) => parseCatalogHash(createHash("sha256").update(value).digest("hex")),
        equals: (a, b) => a === b,
      },
      // Pilot option sets do not trigger other sets.
      facts: {
        validateTriggerGraph: async (input) => input.triggeredOptionSetReferences.length === 0,
      },
      repository: optionSetRepository(tx, s),
    });
  }
  const optionSetRepository = (tx: Tx, s: Scope) =>
    createPostgresOptionSetRepository({
      brandReference: s.brand,
      transactions: { run: (work) => work(ptx(tx)) },
      authorize: async () => (await s.decision("catalog.option_set.manage"))?.effect === "Allow",
    });
  return { query, command };
}
