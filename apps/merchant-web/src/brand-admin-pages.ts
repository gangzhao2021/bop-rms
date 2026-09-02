export type BrandAdminPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class BrandAdminPageError extends Error {
  constructor(readonly code: BrandAdminPageErrorCode) {
    super("Brand administration page unavailable");
    this.name = "BrandAdminPageError";
  }
}
export interface BrandAdminPageClient {
  load(): Promise<unknown>;
}
type Lifecycle = "Draft" | "Active" | "Suspended" | "Archived";
export interface BrandAdminView {
  readonly screenId: "ORG-BRAND-LIST" | "ORG-BRAND-DETAIL";
  readonly queryName: "brand_admin_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayCreate: boolean;
    readonly mayEdit: boolean;
    readonly mayActivate: boolean;
    readonly mayArchive: boolean;
    readonly mayPublish: boolean;
    readonly mayManageStoreMembership: boolean;
  };
  readonly filters: {
    readonly nameOrCode: string | null;
    readonly status: Lifecycle | null;
    readonly countryCode: "CA" | null;
    readonly locale: string | null;
  };
  readonly brands: readonly {
    readonly brandReference: string;
    readonly code: string;
    readonly displayName: string;
    readonly lifecycle: Lifecycle;
    readonly defaultLocale: string;
    readonly supportedLocales: readonly string[];
    readonly storeCount: number;
    readonly catalogSourceReference: string;
    readonly mediaThemeReference: string | null;
    readonly configurationVersion: number;
    readonly configurationStatus:
      "Draft" | "PendingApproval" | "Approved" | "Published" | "Superseded" | "Archived";
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
    readonly storeMemberships: readonly {
      readonly storeReference: string;
      readonly storeCode: string;
      readonly action: "Added" | "Removed";
      readonly effectiveAt: string;
    }[];
    readonly inheritance: readonly {
      readonly fieldCode: string;
      readonly valueReference: string;
      readonly source: "PlatformTemplate" | "BrandBase" | "StoreOverride" | "RuntimeContext";
      readonly sourceVersionReference: string;
      readonly effectiveFrom: string;
      readonly effectiveUntil: string | null;
      readonly overrideAllowed: boolean;
      readonly platformHardRequirement: boolean;
    }[];
    readonly historyReferences: readonly string[];
    readonly auditSummaryReference: string;
  }[];
}
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u,
  LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u,
  INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new BrandAdminPageError("Unavailable");
};
function exact(v: unknown, f: readonly string[]) {
  if (
    v === null ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype
  )
    return fail();
  const k = Reflect.ownKeys(v);
  if (k.length !== f.length || k.some((x) => typeof x !== "string" || !f.includes(x)))
    return fail();
  return v as Record<string, unknown>;
}
const one = <T extends string>(v: unknown, x: readonly T[]) =>
    typeof v === "string" && x.includes(v as T) ? (v as T) : fail(),
  ref = (v: unknown) => (typeof v === "string" && REF.test(v) ? v : fail()),
  nullableRef = (v: unknown) => (v === null ? null : ref(v)),
  code = (v: unknown) => (typeof v === "string" && CODE.test(v) ? v : fail()),
  locale = (v: unknown) => (typeof v === "string" && LOCALE.test(v) ? v : fail()),
  instant = (v: unknown) =>
    typeof v === "string" && INSTANT.test(v) && new Date(Date.parse(v)).toISOString() === v
      ? v
      : fail(),
  nullableInstant = (v: unknown) => (v === null ? null : instant(v)),
  bool = (v: unknown) => (typeof v === "boolean" ? v : fail()),
  count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail()),
  positive = (v: unknown) => (count(v) > 0 ? (v as number) : fail()),
  text = (v: unknown) =>
    typeof v === "string" && v.length > 0 && v.length <= 160 && v.trim() === v ? v : fail();
const lifecycles = ["Draft", "Active", "Suspended", "Archived"] as const;
function membership(v: unknown) {
  const r = exact(v, ["storeReference", "storeCode", "action", "effectiveAt"]);
  return Object.freeze({
    storeReference: ref(r.storeReference),
    storeCode: code(r.storeCode),
    action: one(r.action, ["Added", "Removed"] as const),
    effectiveAt: instant(r.effectiveAt),
  });
}
function inheritance(v: unknown) {
  const r = exact(v, [
      "fieldCode",
      "valueReference",
      "source",
      "sourceVersionReference",
      "effectiveFrom",
      "effectiveUntil",
      "overrideAllowed",
      "platformHardRequirement",
    ]),
    source = one(r.source, [
      "PlatformTemplate",
      "BrandBase",
      "StoreOverride",
      "RuntimeContext",
    ] as const),
    allowed = bool(r.overrideAllowed),
    hard = bool(r.platformHardRequirement);
  if (source === "StoreOverride" && (!allowed || hard)) return fail();
  return Object.freeze({
    fieldCode: code(r.fieldCode),
    valueReference: ref(r.valueReference),
    source,
    sourceVersionReference: ref(r.sourceVersionReference),
    effectiveFrom: instant(r.effectiveFrom),
    effectiveUntil: nullableInstant(r.effectiveUntil),
    overrideAllowed: allowed,
    platformHardRequirement: hard,
  });
}
function brand(v: unknown): BrandAdminView["brands"][number] {
  const r = exact(v, [
    "brandReference",
    "code",
    "displayName",
    "lifecycle",
    "defaultLocale",
    "supportedLocales",
    "storeCount",
    "catalogSourceReference",
    "mediaThemeReference",
    "configurationVersion",
    "configurationStatus",
    "effectiveFrom",
    "effectiveUntil",
    "storeMemberships",
    "inheritance",
    "historyReferences",
    "auditSummaryReference",
  ]);
  if (
    !Array.isArray(r.supportedLocales) ||
    r.supportedLocales.length === 0 ||
    r.supportedLocales.length > 20 ||
    !Array.isArray(r.storeMemberships) ||
    r.storeMemberships.length > 100 ||
    !Array.isArray(r.inheritance) ||
    r.inheritance.length > 100 ||
    !Array.isArray(r.historyReferences) ||
    r.historyReferences.length > 100
  )
    return fail();
  const locales = r.supportedLocales.map(locale),
    members = r.storeMemberships.map(membership),
    resolved = r.inheritance.map(inheritance),
    history = r.historyReferences.map(ref),
    defaultLocale = locale(r.defaultLocale);
  if (
    !locales.includes(defaultLocale) ||
    new Set(locales).size !== locales.length ||
    new Set(members.map((m) => m.storeReference)).size !== members.length ||
    new Set(resolved.map((i) => i.fieldCode)).size !== resolved.length ||
    new Set(history).size !== history.length
  )
    return fail();
  return Object.freeze({
    brandReference: ref(r.brandReference),
    code: code(r.code),
    displayName: text(r.displayName),
    lifecycle: one(r.lifecycle, lifecycles),
    defaultLocale,
    supportedLocales: Object.freeze(locales),
    storeCount: count(r.storeCount),
    catalogSourceReference: ref(r.catalogSourceReference),
    mediaThemeReference: nullableRef(r.mediaThemeReference),
    configurationVersion: positive(r.configurationVersion),
    configurationStatus: one(r.configurationStatus, [
      "Draft",
      "PendingApproval",
      "Approved",
      "Published",
      "Superseded",
      "Archived",
    ] as const),
    effectiveFrom: instant(r.effectiveFrom),
    effectiveUntil: nullableInstant(r.effectiveUntil),
    storeMemberships: Object.freeze(members),
    inheritance: Object.freeze(resolved),
    historyReferences: Object.freeze(history),
    auditSummaryReference: ref(r.auditSummaryReference),
  });
}
export function parseBrandAdminView(v: unknown): BrandAdminView {
  const r = exact(v, [
      "screenId",
      "queryName",
      "queryVersion",
      "generatedAt",
      "sourceAsOf",
      "freshness",
      "completeness",
      "permissions",
      "filters",
      "brands",
    ]),
    screen = one(r.screenId, ["ORG-BRAND-LIST", "ORG-BRAND-DETAIL"] as const);
  if (r.queryName !== "brand_admin_v1" || r.queryVersion !== 1) return fail();
  const p = exact(r.permissions, [
      "mayCreate",
      "mayEdit",
      "mayActivate",
      "mayArchive",
      "mayPublish",
      "mayManageStoreMembership",
    ]),
    f = exact(r.filters, ["nameOrCode", "status", "countryCode", "locale"]);
  if (
    !Array.isArray(r.brands) ||
    r.brands.length > 100 ||
    (screen === "ORG-BRAND-DETAIL" && r.brands.length !== 1)
  )
    return fail();
  const brands = r.brands.map(brand);
  if (new Set(brands.map((b) => b.brandReference)).size !== brands.length) return fail();
  return Object.freeze({
    screenId: screen,
    queryName: "brand_admin_v1",
    queryVersion: 1,
    generatedAt: instant(r.generatedAt),
    sourceAsOf: instant(r.sourceAsOf),
    freshness: one(r.freshness, ["Fresh", "Stale"] as const),
    completeness: one(r.completeness, ["Complete", "Partial"] as const),
    permissions: Object.freeze({
      mayCreate: bool(p.mayCreate),
      mayEdit: bool(p.mayEdit),
      mayActivate: bool(p.mayActivate),
      mayArchive: bool(p.mayArchive),
      mayPublish: bool(p.mayPublish),
      mayManageStoreMembership: bool(p.mayManageStoreMembership),
    }),
    filters: Object.freeze({
      nameOrCode: f.nameOrCode === null ? null : text(f.nameOrCode),
      status: f.status === null ? null : one(f.status, lifecycles),
      countryCode: f.countryCode === null ? null : f.countryCode === "CA" ? "CA" : fail(),
      locale: f.locale === null ? null : locale(f.locale),
    }),
    brands: Object.freeze(brands),
  });
}
export const unavailableBrandAdminPageClient: BrandAdminPageClient = {
  async load() {
    throw new BrandAdminPageError("Unavailable");
  },
};
