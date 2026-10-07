import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  parseCatalogCode as code,
  parseCatalogLocale as locale,
  parseLocalizedNames as names,
  parseCatalogDecimal as decimal,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as digest,
} from "./product-publication-command-client-v2.js";
import {
  parseProductPublicationPeriod as period,
  parseProductPublicationScopes as scopes,
} from "./product-publication-command-client.js";
export class OptionSetAuthoringClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "Conflict"
      | "Unavailable"
      | "OutcomeUnknown"
      | "Stale"
      | "ScopeChanged",
    readonly attemptCode?: "Invalid" | "Denied" | "Conflict",
  ) {
    super("Option Set request could not be confirmed");
    this.name = "OptionSetAuthoringClientError";
  }
}
export type OptionSetAuthoringAction = "Create" | "Edit";
export interface OptionSetAuthoringScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}
const fail = (c: OptionSetAuthoringClientError["code"] = "Invalid"): never => {
  throw new OptionSetAuthoringClientError(c);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function immutable<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const item of Object.values(v)) immutable(item);
    Object.freeze(v);
  }
  return v;
}
/** The existing Product copier's 10k-node budget cannot carry the accepted rich
 * Option document. Match the owning Option 100k-node/depth/string envelope here. */
function copyOptionSetValue(value: unknown): unknown {
  let budget = 100000;
  const copy = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > 4096) return fail();
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return fail();
      return v;
    }
    if (!v || typeof v !== "object") return fail();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 10000 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      return Object.freeze(
        Array.from({ length: v.length }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !("value" in d)) return fail();
          return copy(d.value, depth + 1);
        }),
      );
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 128)
      return fail();
    return Object.freeze(
      Object.fromEntries(
        Reflect.ownKeys(v).map((k) => {
          if (typeof k !== "string") return fail();
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d?.enumerable || !("value" in d)) return fail();
          return [k, copy(d.value, depth + 1)];
        }),
      ),
    );
  };
  return copy(value, 0);
}
function safe<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    return fail();
  }
}
function list<T>(v: unknown, parse: (v: unknown) => T, min = 0) {
  if (!Array.isArray(v) || v.length < min || v.length > 100) return fail();
  return Object.freeze(v.map(parse));
}
function unique<T>(v: readonly T[], key: (v: T) => unknown) {
  if (new Set(v.map(key)).size !== v.length) return fail();
  return v;
}
function integer(v: unknown, min = 0, max = 2147483647) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) return fail();
  return Number(v);
}
const nullable = (v: unknown, parse: (v: unknown) => string) => (v === null ? null : parse(v));
const bool = (v: unknown) => (typeof v === "boolean" ? v : fail());
function choice<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) return fail();
  return v as T;
}
const hash = (v: unknown) =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v) ? v : fail();
const refs = (v: unknown) => unique(list(v, ref), (v) => v);
function texts(v: unknown, min: number, max: number, required?: string) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length > 128) return fail();
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    locale(key);
    if (
      typeof value !== "string" ||
      value.trim().length < min ||
      value.trim().length > max ||
      /[<>{}]|https?:\/\/|www\.|(?:^|\s)[#*_`]/iu.test(value)
    )
      return fail();
    result[key] = value.trim().replace(/\s+/gu, " ");
  }
  if (required && !Object.hasOwn(result, required)) return fail();
  return Object.freeze(result);
}
export function parseOptionSetAuthoringScope(v: unknown): OptionSetAuthoringScope {
  return safe(() => {
    const r = record(copyProductCommandValue(v), [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ]);
    return Object.freeze({
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      actorReference: ref(r.actorReference),
    });
  });
}
const draftKeys = [
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "displayStyle",
  "minimumSelection",
  "maximumSelection",
  "allowRepeatedOption",
  "perOptionMaximumQuantity",
  "maximumTotalQuantity",
  "options",
];
const optionKeys = [
  "stableCode",
  "lifecycle",
  "localizedNames",
  "localizedDescriptions",
  "sortOrder",
  "defaultEligible",
  "triggeredOptionSetReference",
];
function draftFields(r: Record<string, unknown>) {
  const defaultLocale = locale(r.defaultLocale),
    minimumSelection = integer(r.minimumSelection),
    maximumSelection = r.maximumSelection === null ? null : integer(r.maximumSelection),
    perOptionMaximumQuantity = integer(r.perOptionMaximumQuantity, 1),
    maximumTotalQuantity = r.maximumTotalQuantity === null ? null : integer(r.maximumTotalQuantity),
    allowRepeatedOption = bool(r.allowRepeatedOption);
  if (
    (maximumSelection !== null && maximumSelection < minimumSelection) ||
    (maximumTotalQuantity !== null &&
      (maximumTotalQuantity < minimumSelection ||
        perOptionMaximumQuantity > maximumTotalQuantity)) ||
    (!allowRepeatedOption && perOptionMaximumQuantity !== 1)
  )
    return fail();
  return {
    defaultLocale,
    localizedNames: names(r.localizedNames, defaultLocale),
    localizedDescriptions: texts(r.localizedDescriptions, 1, 500),
    displayStyle: choice(r.displayStyle, ["SingleChoice", "MultiChoice", "Quantity"] as const),
    minimumSelection,
    maximumSelection,
    allowRepeatedOption,
    perOptionMaximumQuantity,
    maximumTotalQuantity,
  };
}
function optionFields(r: Record<string, unknown>, defaultLocale: string) {
  return {
    stableCode: code(r.stableCode),
    lifecycle: choice(r.lifecycle, ["Draft", "Active", "Inactive", "Archived"] as const),
    localizedNames: names(r.localizedNames, defaultLocale),
    localizedDescriptions: texts(r.localizedDescriptions, 1, 500),
    sortOrder: integer(r.sortOrder),
    defaultEligible: bool(r.defaultEligible),
    triggeredOptionSetReference: nullable(r.triggeredOptionSetReference, ref),
  };
}
function pinned(v: unknown) {
  if (v === null) return null;
  const r = record(v, ["reference", "versionReference"]);
  return Object.freeze({ reference: ref(r.reference), versionReference: ref(r.versionReference) });
}
function altTexts(v: unknown, defaultLocale: string) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length > 32 ||
    !Object.hasOwn(v, defaultLocale)
  )
    return fail();
  const result: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) {
    locale(k);
    if (
      typeof value !== "string" ||
      value.trim().length < 1 ||
      value.length > 240 ||
      /[<>{}\p{Cc}]|https?:\/\/|www\./u.test(value)
    )
      return fail();
    result[k] = value.trim().replace(/\s+/gu, " ");
  }
  return Object.freeze(result);
}
function detailFields(r: Record<string, unknown>, defaultLocale: string) {
  const q = record(r.quantityRule, ["minimumQuantity", "maximumQuantity"]),
    minimumQuantity = integer(q.minimumQuantity, 0, 999),
    maximumQuantity = integer(q.maximumQuantity, 1, 999);
  if (minimumQuantity > maximumQuantity) return fail();
  const media =
    r.media === null
      ? null
      : (() => {
          const m = record(r.media, [
            "mediaReference",
            "assetReference",
            "assetVersionReference",
            "altText",
          ]);
          return {
            mediaReference: ref(m.mediaReference),
            assetReference: ref(m.assetReference),
            assetVersionReference: ref(m.assetVersionReference),
            altText: altTexts(m.altText, defaultLocale),
          };
        })();
  const consumption =
    r.consumption === null
      ? null
      : (() => {
          const c = record(r.consumption, [
            "kind",
            "reference",
            "versionReference",
            "quantity",
            "unitCode",
          ]);
          return {
            kind: choice(c.kind, ["Inventory", "Recipe"] as const),
            reference: ref(c.reference),
            versionReference: ref(c.versionReference),
            quantity: decimal(c.quantity),
            unitCode: code(c.unitCode),
          };
        })();
  return {
    quantityRule: { minimumQuantity, maximumQuantity },
    media,
    pricingRule: pinned(r.pricingRule),
    consumption,
    triggeredOptionSetVersionReference: nullable(r.triggeredOptionSetVersionReference, ref),
  };
}
const detailKeys = [
  "quantityRule",
  "media",
  "pricingRule",
  "consumption",
  "triggeredOptionSetVersionReference",
];
const additionalKeys = [
  "profile",
  "optionDetails",
  "conditionalRules",
  "conflictRules",
  "scopeSet",
  "effectivePeriod",
];
function additional(
  v: unknown,
  draft: ReturnType<typeof draftFields>,
  optionIds: readonly string[],
  template: boolean,
) {
  const r = record(v, additionalKeys);
  if (r.profile !== "CatalogOptionSetEditorContentV1") return fail();
  const parseId = template ? code : ref,
    key = template ? "stableCode" : "optionReference";
  const known = (v: unknown, min = 0) => {
    const ids = unique(list(v, parseId, min), (v) => v)
      .slice()
      .sort();
    if (ids.some((id) => !optionIds.includes(id))) return fail();
    return ids;
  };
  const optionDetails = unique(
    list(r.optionDetails, (v) => {
      const d = record(v, [key, ...detailKeys]),
        id = parseId(d[key]);
      if (!optionIds.includes(id)) return fail();
      const fields = detailFields(d, draft.defaultLocale);
      if (
        fields.quantityRule.maximumQuantity > draft.perOptionMaximumQuantity ||
        (draft.maximumTotalQuantity !== null &&
          fields.quantityRule.maximumQuantity > draft.maximumTotalQuantity) ||
        (!draft.allowRepeatedOption && fields.quantityRule.maximumQuantity > 1)
      )
        return fail();
      return { id, ...fields };
    }),
    (v) => v.id,
  );
  if (optionDetails.length !== optionIds.length) return fail();
  const when = template ? "whenAllSelectedCodes" : "whenAllSelected",
    required = template ? "requiredOptionCodes" : "requiredOptionReferences",
    forbidden = template ? "forbiddenTogetherCodes" : "forbiddenTogether";
  const conditionalRules = list(r.conditionalRules, (v) => {
      const c = record(v, ["ruleReference", when, required]);
      const a = known(c[when], 1),
        b = known(c[required], 1);
      return { ruleReference: ref(c.ruleReference), [when]: a, [required]: b };
    }),
    conflictRules = list(r.conflictRules, (v) => {
      const c = record(v, ["ruleReference", forbidden]);
      return { ruleReference: ref(c.ruleReference), [forbidden]: known(c[forbidden], 2) };
    });
  unique([...conditionalRules, ...conflictRules], (v) => v.ruleReference);
  unique(conditionalRules, (v) => canonical([v[when], v[required]]));
  unique(conflictRules, (v) => canonical(v[forbidden]));
  for (const rule of conditionalRules) {
    const requiredIds = new Set([
      ...(rule[when] as readonly string[]),
      ...(rule[required] as readonly string[]),
    ]);
    if (
      conflictRules.some((conflict) =>
        (conflict[forbidden] as readonly string[]).every((id) => requiredIds.has(id)),
      )
    )
      return fail();
  }
  const scopeSet = scopes(r.scopeSet);
  if (scopeSet.length > 100) return fail();
  return immutable({
    profile: "CatalogOptionSetEditorContentV1" as const,
    optionDetails: [...optionDetails]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, ...fields }) => ({
        ...fields,
        ...(template ? { stableCode: id } : { optionReference: id }),
      })),
    conditionalRules: [...conditionalRules].sort((a, b) =>
      a.ruleReference.localeCompare(b.ruleReference),
    ),
    conflictRules: [...conflictRules].sort((a, b) =>
      a.ruleReference.localeCompare(b.ruleReference),
    ),
    scopeSet,
    effectivePeriod: period(r.effectivePeriod),
  });
}
export function parseOptionSetEditorContent(value: unknown) {
  return safe(() => {
    const r = record(copyOptionSetValue(value), ["sourceAggregate", ...additionalKeys]),
      root = record(r.sourceAggregate, [
        "optionSetReference",
        "brandReference",
        "internalCode",
        "lifecycle",
        "aggregateVersion",
        "draft",
        "createdAt",
        "createdByActorReference",
        "updatedAt",
      ]),
      set = ref(root.optionSetReference),
      brand = ref(root.brandReference),
      d = record(root.draft, [
        "versionReference",
        "status",
        ...draftKeys,
        "createdAt",
        "updatedAt",
      ]),
      base = draftFields(d);
    if (d.status !== "Draft" || root.lifecycle !== "Draft") return fail();
    const options = unique(
      list(d.options, (v) => {
        const o = record(v, [
            "optionReference",
            "optionSetReference",
            "brandReference",
            ...optionKeys,
            "conflictOptionReferences",
            "createdAt",
            "createdByActorReference",
          ]),
          fields = optionFields(o, base.defaultLocale),
          id = ref(o.optionReference),
          conflicts = refs(o.conflictOptionReferences);
        if (
          o.optionSetReference !== set ||
          o.brandReference !== brand ||
          fields.triggeredOptionSetReference === set ||
          conflicts.includes(id)
        )
          return fail();
        return immutable({
          ...fields,
          optionReference: id,
          optionSetReference: set,
          brandReference: brand,
          conflictOptionReferences: conflicts,
          createdAt: instant(o.createdAt),
          createdByActorReference: ref(o.createdByActorReference),
        });
      }),
      (o) => o.optionReference,
    );
    unique(options, (o) => o.stableCode);
    unique(options, (o) => o.sortOrder);
    if (
      options.some((o) =>
        o.conflictOptionReferences.some((id) => !options.some((v) => v.optionReference === id)),
      ) ||
      base.minimumSelection >
        options.filter((o) => o.lifecycle !== "Archived").length * base.perOptionMaximumQuantity
    )
      return fail();
    const createdAt = instant(root.createdAt),
      updatedAt = instant(root.updatedAt),
      draftCreated = instant(d.createdAt),
      draftUpdated = instant(d.updatedAt);
    if (
      updatedAt < createdAt ||
      draftUpdated < draftCreated ||
      options.some((o) => o.createdAt > draftUpdated)
    )
      return fail();
    const draft = immutable({
        ...base,
        versionReference: ref(d.versionReference),
        status: "Draft" as const,
        options,
        createdAt: draftCreated,
        updatedAt: draftUpdated,
      }),
      sourceAggregate = immutable({
        optionSetReference: set,
        brandReference: brand,
        internalCode: code(root.internalCode),
        lifecycle: "Draft" as const,
        aggregateVersion: integer(root.aggregateVersion, 1),
        draft,
        createdAt,
        createdByActorReference: ref(root.createdByActorReference),
        updatedAt,
      });
    const { sourceAggregate: ignored, ...details } = r;
    void ignored;
    const parsed = additional(
      details,
      base,
      options.map((o) => o.optionReference),
      false,
    );
    for (const o of options) {
      const detail = parsed.optionDetails.find(
        (d) => "optionReference" in d && d.optionReference === o.optionReference,
      );
      if (
        !detail ||
        (o.triggeredOptionSetReference === null) !==
          (detail.triggeredOptionSetVersionReference === null)
      )
        return fail();
    }
    const optionDetails = parsed.optionDetails.map((detail) => {
        if (!("optionReference" in detail)) return fail();
        return { ...detail, optionReference: ref(detail.optionReference) };
      }),
      conditionalRules = parsed.conditionalRules.map((rule) => ({
        ruleReference: rule.ruleReference,
        whenAllSelected: refs(rule.whenAllSelected),
        requiredOptionReferences: refs(rule.requiredOptionReferences),
      })),
      conflictRules = parsed.conflictRules.map((rule) => ({
        ruleReference: rule.ruleReference,
        forbiddenTogether: refs(rule.forbiddenTogether),
      }));
    for (const rule of conditionalRules) {
      const selected = new Set([...rule.whenAllSelected, ...rule.requiredOptionReferences]);
      if (
        options.some(
          (option) =>
            selected.has(option.optionReference) &&
            option.conflictOptionReferences.some((id) => selected.has(id)),
        )
      )
        return fail();
    }
    return immutable({
      ...parsed,
      optionDetails,
      conditionalRules,
      conflictRules,
      sourceAggregate,
    });
  });
}
export type OptionSetEditorContent = ReturnType<typeof parseOptionSetEditorContent>;
export async function contentDigests(content: OptionSetEditorContent) {
  const { sourceAggregate, ...details } = content,
    draft = sourceAggregate.draft;
  const supported = await digest({
    versionReference: draft.versionReference,
    displayStyle: draft.displayStyle,
    minimumSelection: draft.minimumSelection,
    maximumSelection: draft.maximumSelection,
    allowRepeatedOption: draft.allowRepeatedOption,
    perOptionMaximumQuantity: draft.perOptionMaximumQuantity,
    maximumTotalQuantity: draft.maximumTotalQuantity,
    options: draft.options.map((o) => ({
      optionReference: o.optionReference,
      stableCode: o.stableCode,
      lifecycle: o.lifecycle,
      sortOrder: o.sortOrder,
      defaultEligible: o.defaultEligible,
      triggeredOptionSetReference: o.triggeredOptionSetReference,
      conflictOptionReferences: o.conflictOptionReferences,
    })),
  });
  return {
    sourceDigest: await digest(content),
    contentDigest: await digest({ sourceDraft: draft, ...details }),
    configurationDigest: await digest({
      ...details,
      optionDetails: details.optionDetails.map((o) => ({
        ...o,
        media:
          o.media === null
            ? null
            : {
                mediaReference: o.media.mediaReference,
                assetReference: o.media.assetReference,
                assetVersionReference: o.media.assetVersionReference,
              },
      })),
      supportedConfigurationDigest: supported,
    }),
  };
}
function proposed(value: unknown, action: OptionSetAuthoringAction) {
  const r = record(
      copyOptionSetValue(value),
      action === "Create"
        ? ["internalCode", "draft", "additionalContent", "operationReference"]
        : [
            "optionSetReference",
            "expectedAggregateVersion",
            "draft",
            "additionalContent",
            "archiveOptionReferences",
            "operationReference",
          ],
    ),
    d = record(r.draft, draftKeys),
    base = draftFields(d);
  const options = unique(
    list(d.options, (v) => {
      const o = record(v, [
          ...optionKeys,
          "conflictOptionCodes",
          ...(action === "Edit" ? ["identity"] : []),
        ]),
        fields = optionFields(o, base.defaultLocale),
        conflicts = unique(list(o.conflictOptionCodes, code), (v) => v)
          .slice()
          .sort();
      const identity =
        action === "Edit"
          ? (() => {
              const i = record(
                o.identity,
                (o.identity as { kind?: unknown } | null)?.kind === "New"
                  ? ["kind"]
                  : ["kind", "optionReference"],
              );
              if (i.kind === "New") return { kind: "New" as const };
              if (i.kind !== "Existing") return fail();
              return { kind: "Existing" as const, optionReference: ref(i.optionReference) };
            })()
          : null;
      if (
        action === "Edit" &&
        (fields.lifecycle === "Inactive" || fields.lifecycle === "Archived") &&
        fields.defaultEligible
      )
        return fail();
      return immutable({
        ...fields,
        conflictOptionCodes: conflicts,
        ...(identity ? { identity } : {}),
      });
    }),
    (o) => o.stableCode,
  );
  unique(options, (o) => o.sortOrder);
  if (
    options.some(
      (o) =>
        o.conflictOptionCodes.includes(o.stableCode) ||
        o.conflictOptionCodes.some((c) => !options.some((v) => v.stableCode === c)),
    ) ||
    base.minimumSelection >
      options.filter((o) => o.lifecycle !== "Archived").length * base.perOptionMaximumQuantity
  )
    return fail();
  const parsed = additional(
    r.additionalContent,
    base,
    options.map((o) => o.stableCode),
    true,
  );
  const templateDetails = parsed.optionDetails.map((detail) => {
      if (!("stableCode" in detail)) return fail();
      return { ...detail, stableCode: code(detail.stableCode) };
    }),
    templateConditions = parsed.conditionalRules.map((rule) => ({
      ruleReference: rule.ruleReference,
      whenAllSelectedCodes: list(rule.whenAllSelectedCodes, code),
      requiredOptionCodes: list(rule.requiredOptionCodes, code),
    })),
    templateConflicts = parsed.conflictRules.map((rule) => ({
      ruleReference: rule.ruleReference,
      forbiddenTogetherCodes: list(rule.forbiddenTogetherCodes, code),
    }));
  for (const rule of templateConditions) {
    const selected = new Set([...rule.whenAllSelectedCodes, ...rule.requiredOptionCodes]);
    if (
      options.some(
        (option) =>
          selected.has(option.stableCode) &&
          option.conflictOptionCodes.some((c) => selected.has(c)),
      )
    )
      return fail();
  }
  for (const o of options) {
    const detail = parsed.optionDetails.find(
      (d) => "stableCode" in d && d.stableCode === o.stableCode,
    );
    if (
      !detail ||
      (o.triggeredOptionSetReference === null) !==
        (detail.triggeredOptionSetVersionReference === null)
    )
      return fail();
  }
  const draft = immutable({ ...base, options });
  const common = {
    draft,
    additionalContent: immutable({
      ...parsed,
      optionDetails: templateDetails,
      conditionalRules: templateConditions,
      conflictRules: templateConflicts,
    }),
    operationReference: ref(r.operationReference),
  };
  return action === "Create"
    ? immutable({ action, command: { internalCode: code(r.internalCode), ...common } })
    : immutable({
        action,
        command: {
          optionSetReference: ref(r.optionSetReference),
          expectedAggregateVersion: integer(r.expectedAggregateVersion, 1, 2147483646),
          archiveOptionReferences: refs(r.archiveOptionReferences).slice().sort(),
          ...common,
        },
      });
}
export interface OptionSetAuthoringCursor {
  readonly profile: "CatalogOptionSetAuthoringCursorV1";
  readonly scope: OptionSetAuthoringScope;
  readonly action: OptionSetAuthoringAction;
  readonly operationReference: string;
  readonly optionSetReference: string | null;
  readonly expectedAggregateVersion: number | null;
}
export function parseOptionSetAuthoringCursor(v: unknown): OptionSetAuthoringCursor {
  return safe(() => {
    const r = record(copyProductCommandValue(v), [
        "profile",
        "scope",
        "action",
        "operationReference",
        "optionSetReference",
        "expectedAggregateVersion",
      ]),
      action = choice(r.action, ["Create", "Edit"] as const);
    if (
      r.profile !== "CatalogOptionSetAuthoringCursorV1" ||
      (action === "Create" &&
        (r.optionSetReference !== null || r.expectedAggregateVersion !== null))
    )
      return fail();
    return immutable({
      profile: "CatalogOptionSetAuthoringCursorV1",
      scope: parseOptionSetAuthoringScope(r.scope),
      action,
      operationReference: ref(r.operationReference),
      optionSetReference: action === "Create" ? null : ref(r.optionSetReference),
      expectedAggregateVersion:
        action === "Create" ? null : integer(r.expectedAggregateVersion, 1, 2147483646),
    });
  });
}
function anchors(r: Record<string, unknown>, expected: OptionSetAuthoringScope) {
  const actual = parseOptionSetAuthoringScope(
    Object.fromEntries(
      ["tenantReference", "brandReference", "storeReference", "actorReference"].map((k) => [
        k,
        r[k],
      ]),
    ),
  );
  if (!same(actual, expected)) return fail("ScopeChanged");
  return actual;
}
async function checkedContent(raw: Record<string, unknown>, scope: OptionSetAuthoringScope) {
  const content = parseOptionSetEditorContent(raw.content);
  if (content.sourceAggregate.brandReference !== scope.brandReference) return fail("ScopeChanged");
  const hashes = await contentDigests(content);
  if (
    raw.contentDigest !== hashes.contentDigest ||
    raw.configurationDigest !== hashes.configurationDigest ||
    (Object.hasOwn(raw, "sourceDigest") && raw.sourceDigest !== hashes.sourceDigest)
  )
    return fail();
  return { content, ...hashes };
}
export function createOptionSetAuthoringClient(fetcher: typeof fetch = globalThis.fetch) {
  const transport = fetcher.bind(globalThis),
    definitive = new WeakSet<OptionSetAuthoringClientError>();
  function serverError(code: "Invalid" | "Denied" | "Conflict"): never {
    const error = new OptionSetAuthoringClientError(code);
    definitive.add(error);
    throw error;
  }
  async function post(
    path: string,
    body: string,
    scope: Pick<OptionSetAuthoringScope, "brandReference" | "storeReference">,
    csrf: string,
    signal: AbortSignal | undefined,
    write: boolean,
  ) {
    if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf)) return fail();
    if (signal?.aborted) return fail("Unavailable");
    const controller = new AbortController();
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      }),
      abort = () => {
        controller.abort();
        rejectAbort?.(new OptionSetAuthoringClientError(write ? "OutcomeUnknown" : "Unavailable"));
      };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await Promise.race([
        transport(path, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          body,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": csrf,
            "X-BOP-Catalog-Scope": btoa(JSON.stringify(scope))
              .replace(/\+/gu, "-")
              .replace(/\//gu, "_")
              .replace(/=+$/u, ""),
          },
        }),
        aborted,
      ]);
      if (
        controller.signal.aborted ||
        response.headers.get("cache-control") !== "no-store" ||
        !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
        !response.body
      )
        return fail();
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2097152) return fail();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (controller.signal.aborted) return fail();
      const value: unknown = JSON.parse(text);
      if (response.status !== 200) {
        const error = record(value, ["error"]).error;
        if ((response.status === 401 || response.status === 403) && error === "request_denied")
          return serverError("Denied");
        if (response.status === 409 && error === "option_set_authoring_conflict")
          return serverError("Conflict");
        if (
          (response.status === 400 || response.status === 413) &&
          error === "option_set_authoring_invalid"
        )
          return serverError("Invalid");
        return fail();
      }
      return value;
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  const header = (scope: Pick<OptionSetAuthoringScope, "brandReference" | "storeReference">) =>
    Object.freeze({ brandReference: scope.brandReference, storeReference: scope.storeReference });
  async function control<T>(
    path: string,
    command: unknown,
    scope: Pick<OptionSetAuthoringScope, "brandReference" | "storeReference">,
    csrf: string,
    signal: AbortSignal | undefined,
    decode: (v: unknown) => Promise<T> | T,
  ) {
    try {
      const result = await decode(
        await post(path, JSON.stringify(command), header(scope), csrf, signal, false),
      );
      if (signal?.aborted) return fail("Unavailable");
      return result;
    } catch (error) {
      if (
        error instanceof OptionSetAuthoringClientError &&
        (definitive.has(error) || error.code === "ScopeChanged" || error.code === "Stale")
      )
        throw error;
      return fail("Unavailable");
    }
  }
  function prepare(
    value: unknown,
    scopeValue: unknown,
    action: OptionSetAuthoringAction,
    baselineValue?: unknown,
  ) {
    const scope = parseOptionSetAuthoringScope(scopeValue),
      packet = safe(() => proposed(value, action)),
      command = packet.command,
      baseline = action === "Edit" ? parseOptionSetEditorContent(baselineValue) : null;
    if (
      baseline &&
      "optionSetReference" in command &&
      (baseline.sourceAggregate.brandReference !== scope.brandReference ||
        baseline.sourceAggregate.optionSetReference !== command.optionSetReference ||
        baseline.sourceAggregate.aggregateVersion !== command.expectedAggregateVersion)
    )
      return fail("Stale");
    if (baseline && "archiveOptionReferences" in command) {
      const prior = baseline.sourceAggregate.draft.options,
        existing = command.draft.options.flatMap((o) =>
          o.identity?.kind === "Existing" ? [o.identity.optionReference] : [],
        );
      if (
        new Set([...existing, ...command.archiveOptionReferences]).size !==
          existing.length + command.archiveOptionReferences.length ||
        existing.length + command.archiveOptionReferences.length !== prior.length ||
        command.archiveOptionReferences.some(
          (id) => !prior.some((o) => o.optionReference === id),
        ) ||
        command.draft.options.some((o) => {
          if (o.identity?.kind !== "Existing") return false;
          const id = o.identity.optionReference;
          return !prior.some((p) => p.optionReference === id && p.stableCode === o.stableCode);
        })
      )
        return fail();
    }
    const cursor = parseOptionSetAuthoringCursor({
      profile: "CatalogOptionSetAuthoringCursorV1",
      scope,
      action,
      operationReference: command.operationReference,
      optionSetReference: "optionSetReference" in command ? command.optionSetReference : null,
      expectedAggregateVersion:
        "expectedAggregateVersion" in command ? command.expectedAggregateVersion : null,
    });
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).byteLength > 1048576) return fail();
    let uncertain = false,
      active = false;
    return Object.freeze({
      command,
      scope,
      cursor,
      async execute(csrf: string, signal?: AbortSignal) {
        if (active) return fail(uncertain ? "OutcomeUnknown" : "Unavailable");
        if (signal?.aborted) return fail(uncertain ? "OutcomeUnknown" : "Unavailable");
        if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf)) {
          if (uncertain) throw new OptionSetAuthoringClientError("OutcomeUnknown", "Invalid");
          return fail();
        }
        active = true;
        try {
          const raw = record(
            await post(
              action === "Create"
                ? "/merchant/catalog/option-sets/create"
                : "/merchant/catalog/option-sets/draft",
              body,
              header(scope),
              csrf,
              signal,
              true,
            ),
            [
              "profile",
              "action",
              "status",
              "operationReference",
              "contentDigest",
              "configurationDigest",
              "referenceEligibility",
              "storeReference",
              "content",
            ],
          );
          if (
            raw.profile !== "CatalogOptionSetAuthoringCommandResultV1" ||
            raw.action !== action ||
            raw.operationReference !== command.operationReference ||
            raw.storeReference !== scope.storeReference ||
            raw.referenceEligibility !== "NotEvaluated" ||
            (raw.status !== "Applied" && raw.status !== "Replayed")
          )
            return fail();
          const checked = await checkedContent(raw, scope),
            root = checked.content.sourceAggregate;
          if (
            root.aggregateVersion !==
              (action === "Create" ? 1 : (cursor.expectedAggregateVersion ?? 0) + 1) ||
            (action === "Create"
              ? root.internalCode !== ("internalCode" in command ? command.internalCode : null) ||
                root.createdByActorReference !== scope.actorReference
              : root.optionSetReference !== cursor.optionSetReference)
          )
            return fail();
          // Compare every explicitly proposed field to actual allocated identities.
          for (const expected of command.draft.options) {
            const actual = root.draft.options.find((o) => o.stableCode === expected.stableCode);
            if (
              !actual ||
              ("identity" in expected &&
                expected.identity?.kind === "Existing" &&
                actual.optionReference !== expected.identity.optionReference)
            )
              return fail();
            if (
              (action === "Create" || expected.identity?.kind === "New") &&
              (actual.createdAt !== root.updatedAt ||
                actual.createdByActorReference !== scope.actorReference)
            )
              return fail();
            const {
              conflictOptionCodes,
              identity: ignored,
              ...template
            } = expected as typeof expected & { identity?: unknown };
            void ignored;
            const {
              optionReference,
              optionSetReference,
              brandReference,
              conflictOptionReferences,
              createdAt,
              createdByActorReference,
              ...actualTemplate
            } = actual;
            void optionSetReference;
            void brandReference;
            void createdAt;
            void createdByActorReference;
            if (
              !same(template, actualTemplate) ||
              !same(
                conflictOptionCodes
                  .map((c) => root.draft.options.find((o) => o.stableCode === c)?.optionReference)
                  .sort(),
                [...conflictOptionReferences].sort(),
              )
            )
              return fail();
            const expectedDetail = command.additionalContent.optionDetails.find(
                (d) => d.stableCode === expected.stableCode,
              ),
              actualDetail = checked.content.optionDetails.find(
                (d) => d.optionReference === optionReference,
              );
            if (!expectedDetail || !actualDetail) return fail();
            const { stableCode: ignoredCode, ...proposedDetail } = expectedDetail,
              { optionReference: ignoredRef, ...returnedDetail } = actualDetail;
            void ignoredCode;
            void ignoredRef;
            if (!same(proposedDetail, returnedDetail)) return fail();
          }
          const { options: ignoredOptions, ...draftTemplate } = command.draft,
            {
              options: ignoredActual,
              versionReference,
              status,
              createdAt,
              updatedAt,
              ...returnedDraft
            } = root.draft;
          void ignoredOptions;
          void ignoredActual;
          void versionReference;
          void status;
          void createdAt;
          void updatedAt;
          if (
            !same(draftTemplate, returnedDraft) ||
            !same(command.additionalContent.scopeSet, checked.content.scopeSet) ||
            !same(command.additionalContent.effectivePeriod, checked.content.effectivePeriod)
          )
            return fail();
          const resolveCode = (c: string) => {
            const o = root.draft.options.find((o) => o.stableCode === c);
            if (!o) return fail();
            return o.optionReference;
          };
          const conditions = command.additionalContent.conditionalRules.map((rule) => ({
              ruleReference: rule.ruleReference,
              whenAllSelected: rule.whenAllSelectedCodes.map(resolveCode).sort(),
              requiredOptionReferences: rule.requiredOptionCodes.map(resolveCode).sort(),
            })),
            conflicts = command.additionalContent.conflictRules.map((rule) => ({
              ruleReference: rule.ruleReference,
              forbiddenTogether: rule.forbiddenTogetherCodes.map(resolveCode).sort(),
            }));
          if (
            !same(conditions, checked.content.conditionalRules) ||
            !same(conflicts, checked.content.conflictRules)
          )
            return fail();
          const archived =
            "archiveOptionReferences" in command ? command.archiveOptionReferences : [];
          if (
            root.draft.options.length !== command.draft.options.length + archived.length ||
            root.draft.updatedAt !== root.updatedAt
          )
            return fail();
          if (
            action === "Create" &&
            (root.createdAt !== root.updatedAt || root.draft.createdAt !== root.createdAt)
          )
            return fail();
          if (baseline) {
            const original = baseline.sourceAggregate;
            if (
              root.internalCode !== original.internalCode ||
              root.createdAt !== original.createdAt ||
              root.createdByActorReference !== original.createdByActorReference ||
              root.draft.versionReference !== original.draft.versionReference ||
              root.draft.createdAt !== original.draft.createdAt ||
              root.updatedAt < original.updatedAt
            )
              return fail();
            for (const previous of original.draft.options) {
              const current = root.draft.options.find(
                (o) => o.optionReference === previous.optionReference,
              );
              if (
                !current ||
                current.createdAt !== previous.createdAt ||
                current.createdByActorReference !== previous.createdByActorReference
              )
                return fail();
              if (archived.includes(previous.optionReference)) {
                const {
                    lifecycle: oldLife,
                    sortOrder: oldOrder,
                    defaultEligible: oldDefault,
                    ...old
                  } = previous,
                  {
                    lifecycle: newLife,
                    sortOrder: newOrder,
                    defaultEligible: newDefault,
                    ...now
                  } = current;
                void oldLife;
                void oldOrder;
                void oldDefault;
                void newOrder;
                if (
                  newLife !== "Archived" ||
                  newDefault !== false ||
                  !same(old, now) ||
                  !same(
                    baseline.optionDetails.find(
                      (d) => d.optionReference === previous.optionReference,
                    ),
                    checked.content.optionDetails.find(
                      (d) => d.optionReference === previous.optionReference,
                    ),
                  )
                )
                  return fail();
              }
            }
          }
          if (signal?.aborted) return fail("OutcomeUnknown");
          uncertain = false;
          return immutable({
            profile: "CatalogOptionSetAuthoringCommandResultV1" as const,
            action,
            status: raw.status as "Applied" | "Replayed",
            operationReference: command.operationReference,
            storeReference: scope.storeReference,
            referenceEligibility: "NotEvaluated" as const,
            ...checked,
            scope,
            cursor,
          });
        } catch (error) {
          if (error instanceof OptionSetAuthoringClientError && definitive.has(error)) {
            if (!uncertain) throw error;
            throw new OptionSetAuthoringClientError(
              "OutcomeUnknown",
              error.code as "Invalid" | "Denied" | "Conflict",
            );
          }
          uncertain = true;
          return fail("OutcomeUnknown");
        } finally {
          active = false;
        }
      },
    });
  }
  return Object.freeze({
    prepareCreate: (value: unknown, scope: unknown) => prepare(value, scope, "Create"),
    prepareDraft: (value: unknown, scope: unknown, baseline: unknown) =>
      prepare(value, scope, "Edit", baseline),
    async context(
      action: OptionSetAuthoringAction,
      selected: unknown,
      csrf: string,
      signal?: AbortSignal,
    ) {
      const s = safe(() => {
        const r = record(copyProductCommandValue(selected), ["brandReference", "storeReference"]);
        return { brandReference: ref(r.brandReference), storeReference: ref(r.storeReference) };
      });
      if (action !== "Create" && action !== "Edit") return fail();
      try {
        const r = record(
          await post(
            "/merchant/catalog/option-sets/authoring/context",
            JSON.stringify({ action }),
            s,
            csrf,
            signal,
            false,
          ),
          [
            "profile",
            "action",
            "tenantReference",
            "brandReference",
            "storeReference",
            "actorReference",
            "observedAt",
            "validUntil",
          ],
        );
        if (
          r.profile !== "CatalogOptionSetAuthoringContextV1" ||
          r.action !== action ||
          r.brandReference !== s.brandReference ||
          r.storeReference !== s.storeReference
        )
          return fail("ScopeChanged");
        const observedAt = instant(r.observedAt),
          validUntil = instant(r.validUntil);
        if (
          validUntil <= observedAt ||
          Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
          Date.now() < Date.parse(observedAt) ||
          Date.now() >= Date.parse(validUntil)
        )
          return fail("Stale");
        const scope = parseOptionSetAuthoringScope(
          Object.fromEntries(
            ["tenantReference", "brandReference", "storeReference", "actorReference"].map((k) => [
              k,
              r[k],
            ]),
          ),
        );
        return immutable({
          profile: "CatalogOptionSetAuthoringContextV1" as const,
          action,
          scope,
          observedAt,
          validUntil,
        });
      } catch (error) {
        if (
          error instanceof OptionSetAuthoringClientError &&
          (definitive.has(error) || error.code === "ScopeChanged" || error.code === "Stale")
        )
          throw error;
        return fail("Unavailable");
      }
    },
    async readCurrent(
      commandValue: unknown,
      scopeValue: unknown,
      csrf: string,
      signal?: AbortSignal,
    ) {
      const scope = safe(() => {
          const value = copyProductCommandValue(scopeValue);
          if (value !== null && typeof value === "object" && Object.keys(value).length === 2) {
            const r = record(value, ["brandReference", "storeReference"]);
            return Object.freeze({
              brandReference: ref(r.brandReference),
              storeReference: ref(r.storeReference),
            });
          }
          return parseOptionSetAuthoringScope(value);
        }),
        command = safe(() => {
          const r = record(copyProductCommandValue(commandValue), [
            "optionSetReference",
            "expectedAggregateVersion",
          ]);
          return {
            optionSetReference: ref(r.optionSetReference),
            expectedAggregateVersion:
              r.expectedAggregateVersion === null ? null : integer(r.expectedAggregateVersion, 1),
          };
        });
      return control(
        "/merchant/catalog/option-sets/current-editor",
        command,
        scope,
        csrf,
        signal,
        async (value) => {
          const r = record(value, [
            "profile",
            "tenantReference",
            "brandReference",
            "actorReference",
            "storeReference",
            "content",
            "sourceDigest",
            "contentDigest",
            "configurationDigest",
            "referenceEligibility",
          ]);
          if (
            r.profile !== "CatalogOptionSetCurrentEditorResultV1" ||
            r.referenceEligibility !== "NotEvaluated"
          )
            return fail();
          // First read acquires actual Tenant/Actor from this authenticated owner
          // response. Once known, all four scope anchors remain mandatory.
          const actual = parseOptionSetAuthoringScope(
            Object.fromEntries(
              ["tenantReference", "brandReference", "storeReference", "actorReference"].map((k) => [
                k,
                r[k],
              ]),
            ),
          );
          if (
            actual.brandReference !== scope.brandReference ||
            actual.storeReference !== scope.storeReference
          )
            return fail("ScopeChanged");
          if ("tenantReference" in scope) anchors(r, parseOptionSetAuthoringScope(scope));
          const checked = await checkedContent(r, actual);
          if (checked.content.sourceAggregate.optionSetReference !== command.optionSetReference)
            return fail("ScopeChanged");
          if (
            command.expectedAggregateVersion !== null &&
            checked.content.sourceAggregate.aggregateVersion !== command.expectedAggregateVersion
          )
            return fail("Stale");
          return immutable({
            ...checked,
            scope: actual,
            referenceEligibility: "NotEvaluated" as const,
          });
        },
      );
    },
    async resolve(cursorValue: unknown, scopeValue: unknown, csrf: string, signal?: AbortSignal) {
      const cursor = parseOptionSetAuthoringCursor(cursorValue),
        scope = parseOptionSetAuthoringScope(scopeValue);
      if (!same(scope, cursor.scope)) return fail("ScopeChanged");
      const command = {
        profile: "CatalogOptionSetAuthoringResolutionRequestV1",
        tenantReference: scope.tenantReference,
        action: cursor.action,
        operationReference: cursor.operationReference,
        optionSetReference: cursor.optionSetReference,
        expectedAggregateVersion: cursor.expectedAggregateVersion,
      };
      return control(
        "/merchant/catalog/option-sets/authoring/resolve",
        command,
        scope,
        csrf,
        signal,
        async (value) => {
          const r = record(value, ["profile", "storeReference", "resolution", "content"]);
          if (
            r.profile !== "CatalogOptionSetAuthoringResolutionResultV1" ||
            r.storeReference !== scope.storeReference
          )
            return fail("ScopeChanged");
          const resolution = record(r.resolution, [
              "profile",
              "outcome",
              "command",
              "identity",
              "recordedAt",
              "digest",
            ]),
            c = record(resolution.command, [
              "profile",
              "tenantReference",
              "brandReference",
              "actorReference",
              "action",
              "reasonCode",
              "operationReference",
              "optionSetReference",
              "expectedAggregateVersion",
            ]),
            expected = {
              ...command,
              profile: "CatalogOptionSetAuthoringResolutionCommandV1",
              brandReference: scope.brandReference,
              actorReference: scope.actorReference,
              reasonCode: "AUTHORIZED_OPERATION",
            };
          if (
            !same(c, expected) ||
            resolution.profile !== "CatalogOptionSetAuthoringResolutionV1" ||
            (resolution.outcome !== "Committed" && resolution.outcome !== "Abandoned")
          )
            return fail();
          instant(resolution.recordedAt);
          const { digest: resolutionDigest, ...body } = resolution;
          if (hash(resolutionDigest) !== (await digest(body))) return fail();
          if (resolution.outcome === "Abandoned") {
            if (resolution.identity !== null || r.content !== null) return fail();
            return immutable({
              cursor,
              resolution: {
                profile: "CatalogOptionSetAuthoringResolutionV1" as const,
                outcome: "Abandoned" as const,
                command: expected,
                identity: null,
                recordedAt: instant(resolution.recordedAt),
                digest: hash(resolutionDigest),
              },
              content: null,
            });
          }
          const identity = record(resolution.identity, [
              "profile",
              "command",
              "sourceOperationReference",
              "optionSetReference",
              "versionReference",
              "aggregateVersion",
              "originalOccurredAt",
              "auditReference",
              "originalIntentDigest",
              "sourceDigest",
              "contentDigest",
              "configurationDigest",
              "digest",
            ]),
            { digest: identityDigest, ...identityBody } = identity;
          if (
            identity.profile !== "CatalogOptionSetAuthoringIdentityV1" ||
            !same(identity.command, c) ||
            identity.sourceOperationReference !== cursor.operationReference ||
            identity.aggregateVersion !==
              (cursor.action === "Create" ? 1 : (cursor.expectedAggregateVersion ?? 0) + 1) ||
            hash(identityDigest) !== (await digest(identityBody))
          )
            return fail();
          ref(identity.auditReference);
          hash(identity.originalIntentDigest);
          const checked = await checkedContent({ ...identity, content: r.content }, scope),
            root = checked.content.sourceAggregate;
          if (
            root.optionSetReference !== identity.optionSetReference ||
            root.draft.versionReference !== identity.versionReference ||
            root.aggregateVersion !== identity.aggregateVersion ||
            root.updatedAt !== identity.originalOccurredAt ||
            identity.originalOccurredAt !== resolution.recordedAt ||
            (cursor.action === "Edit" && root.optionSetReference !== cursor.optionSetReference)
          )
            return fail();
          return immutable({
            cursor,
            resolution: {
              profile: "CatalogOptionSetAuthoringResolutionV1" as const,
              outcome: "Committed" as const,
              command: expected,
              identity: {
                profile: "CatalogOptionSetAuthoringIdentityV1" as const,
                command: expected,
                sourceOperationReference: cursor.operationReference,
                optionSetReference: root.optionSetReference,
                versionReference: root.draft.versionReference,
                aggregateVersion: root.aggregateVersion,
                originalOccurredAt: instant(identity.originalOccurredAt),
                auditReference: ref(identity.auditReference),
                originalIntentDigest: hash(identity.originalIntentDigest),
                sourceDigest: checked.sourceDigest,
                contentDigest: checked.contentDigest,
                configurationDigest: checked.configurationDigest,
                digest: hash(identityDigest),
              },
              recordedAt: instant(resolution.recordedAt),
              digest: hash(resolutionDigest),
            },
            content: checked.content,
          });
        },
      );
    },
  });
}
export type OptionSetAuthoringClient = ReturnType<typeof createOptionSetAuthoringClient>;
export type OptionSetAuthoringContext = Awaited<ReturnType<OptionSetAuthoringClient["context"]>>;
export type OptionSetCurrentEditorView = Awaited<
  ReturnType<OptionSetAuthoringClient["readCurrent"]>
>;
export type OptionSetAuthoringResolution = Awaited<ReturnType<OptionSetAuthoringClient["resolve"]>>;
export type OptionSetPreparedAuthoringRequest = ReturnType<
  OptionSetAuthoringClient["prepareCreate"]
>;
export type OptionSetAuthoringReceipt = Awaited<
  ReturnType<OptionSetPreparedAuthoringRequest["execute"]>
>;
