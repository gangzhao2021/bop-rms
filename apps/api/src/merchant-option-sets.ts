import { createHash } from "node:crypto";
import {
  CatalogError,
  createOptionSetService,
  createPostgresOptionSetRepository,
  listBrandOptionSets,
  parseCatalogHash,
  parseCatalogReference,
  type OptionSetAggregate,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { derivedReference } from "./merchant-products.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 slice 4: CAT-OPTIONSET-LIST / CAT-OPTIONSET-EDIT for the selected Store's Brand — choices
 * customers make on an item (milk, extra shot). A set is "choose one", "choose any" or "choose a
 * quantity" with its limits; each option can be offered or not offered. Options are never deleted
 * (orders refer to them). Changes reach customers when a menu that uses the set is next published;
 * an option that stops being offered cannot be ordered from then on.
 */
export class MerchantOptionSetError extends Error {
  constructor(readonly code: "PermissionDenied" | "NotFound" | "Conflict" | "Invalid") {
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
    readonly offered: boolean;
    readonly defaultChoice: boolean;
  }[];
}
export type OptionSetCommandBody =
  | ({ readonly action: "Create"; readonly operationReference: string } & OptionSetBody)
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
      Object.keys(o).sort().join(",") !== "defaultChoice,name,offered,optionReference" ||
      typeof o.offered !== "boolean" ||
      typeof o.defaultChoice !== "boolean"
    )
      return fail("Invalid");
    return {
      optionReference: o.optionReference === null ? null : ref(o.optionReference),
      name: text(o.name, 80),
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
  return { name: text(r.name, 80), kind, minimum, maximum, perOptionMaximum, options };
}
export function parseOptionSetCommandBody(value: unknown): OptionSetCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (r.action === "Create" && keys === keysOf("action", "operationReference", ...bodyKeys))
    return { action: "Create", operationReference: ref(r.operationReference), ...parseBody(r) };
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
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
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
  const view = (set: OptionSetAggregate) => ({
    optionSetReference: set.optionSetReference,
    internalCode: set.internalCode,
    aggregateVersion: set.aggregateVersion,
    archived: set.lifecycle === "Archived",
    name: name(set.draft.localizedNames, set.internalCode),
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
        offered: option.lifecycle === "Active",
        defaultChoice: option.defaultEligible,
      })),
  });

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    optionSetReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const sets = await listBrandOptionSets(ptx(tx), { brandReference: s.brand });
        const base = {
          sourceAsOf: options.persistence.now(),
          permissions: s.permissions,
        };
        if (input.optionSetReference === null)
          return { screenId: "CAT-OPTIONSET-LIST" as const, ...base, optionSets: sets.map(view) };
        const set = sets.find(
          (candidate) => candidate.optionSetReference === input.optionSetReference,
        );
        if (set === undefined) return fail("NotFound");
        return { screenId: "CAT-OPTIONSET-EDIT" as const, ...base, optionSet: view(set) };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseOptionSetCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
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
          return { status: "AlreadyApplied" as const, optionSet: view(record.aggregate) };
        }
        try {
          if (body.action === "Create") {
            const code = codeForName(body.name, "SET");
            const result = await service.create({
              internalCode: code,
              defaultLocale: options.locale,
              localizedNames: { [options.locale]: body.name },
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
            return { status: result.status, optionSet: view(result.aggregate) };
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
            return { status: result.status, optionSet: view(result.aggregate) };
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
          const result = await service.replaceDraft({
            optionSetReference: body.optionSetReference,
            expectedAggregateVersion: body.expectedAggregateVersion,
            draft: {
              ...existing.draft,
              localizedNames: { ...existing.draft.localizedNames, [options.locale]: body.name },
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
            },
            operationReference: body.operationReference,
            requestedAt: at,
          });
          return { status: result.status, optionSet: view(result.aggregate) };
        } catch (error) {
          const mapped = error instanceof CatalogError ? catalogErrors[error.code] : undefined;
          if (mapped !== undefined) return fail(mapped);
          throw error;
        }
      }),
    );
  };

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
          localizedNames: { ...existing.localizedNames, [options.locale]: option.name },
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
        localizedNames: { [options.locale]: option.name },
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
