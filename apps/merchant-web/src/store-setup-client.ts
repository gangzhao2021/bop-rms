import { parseTaxConfigClassificationChoices } from "./tax-config-authoring-client.js";
import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import {
  parseServiceIntervals,
  type ServiceInterval,
  type ServiceMode,
} from "./service-control-client.js";
export class StoreSetupClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "Conflict"
      | "Unavailable"
      | "OutcomeUnknown"
      | "ScopeChanged"
      | "Stale",
  ) {
    super("Store setup could not be confirmed");
    this.name = "StoreSetupClientError";
  }
}
const fail = (code: StoreSetupClientError["code"] = "Invalid"): never => {
  throw new StoreSetupClientError(code);
};
const safe = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (error instanceof StoreSetupClientError) throw error;
    return fail();
  }
};
const integer = (value: unknown, min = 0): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= 2147483647
    ? value
    : fail();
const digest = (value: unknown): string =>
  typeof value === "string" && value.length === 71 && /^sha256:[a-f0-9]{64}$/u.test(value)
    ? value
    : fail();
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const zone = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone !== value
  )
    return fail();
  return value;
};
const locale = (value: unknown): string =>
  typeof value === "string" && /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|[0-9]{3})?$/u.test(value)
    ? value
    : fail();
export interface StoreSetupScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}
export function parseStoreSetupScope(value: unknown): StoreSetupScope {
  return safe(() => {
    const r = record(value, [
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
export type StoreSetupValue<T> =
  Readonly<{ state: "Unconfigured" }> | Readonly<{ state: "Configured"; value: T }>;
export interface StoreSetupContentValues {
  source: "BrandInherited" | "StoreOverride";
  brandBaseVersionReference: string;
  timeZone: string;
  businessDayStartLocalTime: string;
  addressReference: string;
  contactReference: string;
  receiptReference: string;
  taxConfigurationReference: string;
  paymentConfigurationReference: string;
  capacityConfigurationReference: string | null;
  enabledServiceModes: readonly ServiceMode[];
  weeklySchedule: readonly {
    readonly isoWeekday: number;
    readonly intervals: readonly ServiceInterval[];
  }[];
  exceptions: readonly {
    readonly localDate: string;
    readonly kind: "Holiday" | "TemporaryClosure" | "Override";
    readonly intervals: readonly ServiceInterval[];
  }[];
  effectiveFrom: string;
  effectiveUntil: string | null;
}
export type StoreSetupFeeCharge = "ServiceCharge" | "DeliveryFee" | "Tip";
export type StoreSetupFeeContext =
  | Readonly<{ chargeType: StoreSetupFeeCharge; state: "Unconfigured" | "Disabled" }>
  | Readonly<{
      chargeType: StoreSetupFeeCharge;
      state: "Enabled";
      taxClassificationReference: string;
      orderTypes: readonly ServiceMode[];
    }>;
export type StoreSetupContent = {
  readonly [K in keyof StoreSetupContentValues]: StoreSetupValue<StoreSetupContentValues[K]>;
} & { readonly feeContexts?: StoreSetupValue<readonly StoreSetupFeeContext[]> };
export const storeSetupFeeCharges = Object.freeze(["ServiceCharge", "DeliveryFee", "Tip"] as const);
export function parseStoreSetupFeeContexts(value: unknown): readonly StoreSetupFeeContext[] {
  return safe(() => {
    const copied = copySetupContent(value);
    if (!Array.isArray(copied) || copied.length !== 3) return fail();
    return Object.freeze(
      copied.map((entry, i): StoreSetupFeeContext => {
        const enabled = Object.getOwnPropertyDescriptor(entry ?? {}, "state")?.value === "Enabled";
        const r = record(
          entry,
          enabled
            ? ["chargeType", "state", "taxClassificationReference", "orderTypes"]
            : ["chargeType", "state"],
        );
        const chargeType = storeSetupFeeCharges[i];
        if (!chargeType || r.chargeType !== chargeType) return fail();
        if (r.state === "Unconfigured" || r.state === "Disabled")
          return Object.freeze({ chargeType, state: r.state });
        if (
          r.state !== "Enabled" ||
          !Array.isArray(r.orderTypes) ||
          r.orderTypes.length === 0 ||
          r.orderTypes.length > 3 ||
          new Set(r.orderTypes).size !== r.orderTypes.length ||
          r.orderTypes.some((v) => !["DineIn", "Pickup", "Delivery"].includes(v))
        )
          return fail();
        const orderTypes = r.orderTypes;
        return Object.freeze({
          chargeType,
          state: "Enabled",
          taxClassificationReference: ref(r.taxClassificationReference),
          orderTypes: Object.freeze(
            (["DineIn", "Pickup", "Delivery"] as const).filter((v) => orderTypes.includes(v)),
          ),
        });
      }),
    );
  });
}
export function normalizeStoreSetupContentV2(value: StoreSetupContent): StoreSetupContent {
  return parseStoreSetupContent({
    ...value,
    feeContexts: value.feeContexts ?? { state: "Unconfigured" },
  });
}
export function createUnconfiguredStoreSetupContentV2(): StoreSetupContent {
  return normalizeStoreSetupContentV2(createUnconfiguredStoreSetupContent());
}
export const storeSetupContentFields = Object.freeze([
  "source",
  "brandBaseVersionReference",
  "timeZone",
  "businessDayStartLocalTime",
  "addressReference",
  "contactReference",
  "receiptReference",
  "taxConfigurationReference",
  "paymentConfigurationReference",
  "capacityConfigurationReference",
  "enabledServiceModes",
  "weeklySchedule",
  "exceptions",
  "effectiveFrom",
  "effectiveUntil",
] as const);
export function createUnconfiguredStoreSetupContent(): StoreSetupContent {
  return parseStoreSetupContent(
    Object.fromEntries(storeSetupContentFields.map((key) => [key, { state: "Unconfigured" }])),
  );
}
function configured<T>(value: unknown, parse: (value: unknown) => T): StoreSetupValue<T> {
  const r = record(
    value,
    Object.getOwnPropertyDescriptor(value ?? {}, "state")?.value === "Unconfigured"
      ? ["state"]
      : ["state", "value"],
  );
  if (r.state === "Unconfigured") return Object.freeze({ state: "Unconfigured" });
  if (r.state !== "Configured") return fail();
  return Object.freeze({ state: "Configured", value: parse(r.value) });
}
// Product command copy has a smaller 10k-node budget. Store's accepted 366
// exception schedules require the owning partial-contract 100k bound instead.
function copySetupContent(raw: unknown): unknown {
  let remaining = 100000;
  const copy = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 12) return fail();
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : fail();
    if (!value || typeof value !== "object") return fail();
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, "length");
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        !length ||
        !("value" in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > 100000 ||
        Reflect.ownKeys(value).length !== length.value + 1
      )
        return fail();
      return Object.freeze(
        Array.from({ length: length.value }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(value, String(i));
          if (!d || !d.enumerable || !("value" in d)) return fail();
          return copy(d.value, depth + 1);
        }),
      );
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return fail();
    return Object.freeze(
      Object.fromEntries(
        Reflect.ownKeys(value).map((key) => {
          const d = Object.getOwnPropertyDescriptor(value, key);
          if (typeof key !== "string" || !d?.enumerable || !("value" in d)) return fail();
          return [key, copy(d.value, depth + 1)];
        }),
      ),
    );
  };
  return copy(raw, 0);
}
export function parseStoreSetupContent(raw: unknown): StoreSetupContent {
  return safe(() => {
    const copied = copySetupContent(raw);
    const hasFees =
      copied !== null && typeof copied === "object" && Object.hasOwn(copied, "feeContexts");
    const r = record(
      copied,
      hasFees ? [...storeSetupContentFields, "feeContexts"] : storeSetupContentFields,
    );
    const modes = (value: unknown): readonly ServiceMode[] => {
      if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > 3 ||
        new Set(value).size !== value.length ||
        value.some((v) => !["DineIn", "Pickup", "Delivery"].includes(v))
      )
        return fail();
      return Object.freeze(
        (["DineIn", "Pickup", "Delivery"] as const).filter((v) => value.includes(v)),
      );
    };
    const intervals = (value: unknown) => {
      const result = parseServiceIntervals(value)
        .map((v) => Object.freeze({ ...v, serviceModes: modes(v.serviceModes) }))
        .sort((a, b) => a.startLocalTime.localeCompare(b.startLocalTime));
      for (let i = 1; i < result.length; i++) {
        const previous = result[i - 1],
          current = result[i];
        if (
          !previous ||
          !current ||
          previous.endsNextDay ||
          previous.endLocalTime > current.startLocalTime
        )
          return fail();
      }
      return Object.freeze(result);
    };
    const weekly = (value: unknown) => {
      if (!Array.isArray(value) || value.length !== 7) return fail();
      return Object.freeze(
        value.map((day, i) => {
          const d = record(day, ["isoWeekday", "intervals"]);
          if (d.isoWeekday !== i + 1) return fail();
          return Object.freeze({ isoWeekday: i + 1, intervals: intervals(d.intervals) });
        }),
      );
    };
    const exceptions = (value: unknown) => {
      if (!Array.isArray(value) || value.length > 366) return fail();
      const parsed = value.map((entry) => {
        const e = record(entry, ["localDate", "kind", "intervals"]);
        if (
          typeof e.localDate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(e.localDate) ||
          new Date(e.localDate + "T00:00:00.000Z").toISOString().slice(0, 10) !== e.localDate ||
          (e.kind !== "Holiday" && e.kind !== "TemporaryClosure" && e.kind !== "Override")
        )
          return fail();
        return Object.freeze({
          localDate: e.localDate,
          kind: e.kind,
          intervals: intervals(e.intervals),
        });
      });
      if (new Set(parsed.map((v) => v.localDate)).size !== parsed.length) return fail();
      return Object.freeze(parsed.sort((a, b) => a.localDate.localeCompare(b.localDate)));
    };
    const content: StoreSetupContent = {
      ...(hasFees ? { feeContexts: configured(r.feeContexts, parseStoreSetupFeeContexts) } : {}),
      source: configured(r.source, (v) =>
        v === "BrandInherited" || v === "StoreOverride" ? v : fail(),
      ),
      brandBaseVersionReference: configured(r.brandBaseVersionReference, ref),
      timeZone: configured(r.timeZone, zone),
      businessDayStartLocalTime: configured(r.businessDayStartLocalTime, (v) =>
        typeof v === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(v) ? v : fail(),
      ),
      addressReference: configured(r.addressReference, ref),
      contactReference: configured(r.contactReference, ref),
      receiptReference: configured(r.receiptReference, ref),
      taxConfigurationReference: configured(r.taxConfigurationReference, ref),
      paymentConfigurationReference: configured(r.paymentConfigurationReference, ref),
      capacityConfigurationReference: configured(r.capacityConfigurationReference, nullableRef),
      enabledServiceModes: configured(r.enabledServiceModes, modes),
      weeklySchedule: configured(r.weeklySchedule, weekly),
      exceptions: configured(r.exceptions, exceptions),
      effectiveFrom: configured(r.effectiveFrom, instant),
      effectiveUntil: configured(r.effectiveUntil, (v) => (v === null ? null : instant(v))),
    };
    if (
      content.effectiveFrom.state === "Configured" &&
      content.effectiveUntil.state === "Configured" &&
      content.effectiveUntil.value !== null &&
      content.effectiveUntil.value <= content.effectiveFrom.value
    )
      return fail();
    return Object.freeze(content);
  });
}
export interface StoreSetupSnapshot {
  readonly profile: "StoreSetupDraftV1" | "StoreSetupDraftV2";
  readonly setupDraftReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly defaultLocale: string;
  readonly currencyCode: "CAD";
  readonly baseConfigurationReference: string | null;
  readonly content: StoreSetupContent;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly purposeCode: "STORE_SETUP_DRAFT";
  readonly dataClassification: "ConfigurationMetadata";
}
export function parseStoreSetupSnapshot(raw: unknown): StoreSetupSnapshot {
  return safe(() => {
    const r = record(raw, [
      "profile",
      "setupDraftReference",
      "tenantReference",
      "brandReference",
      "storeReference",
      "revision",
      "authoredByReference",
      "defaultLocale",
      "currencyCode",
      "baseConfigurationReference",
      "content",
      "createdAt",
      "updatedAt",
      "purposeCode",
      "dataClassification",
    ]);
    if (
      (r.profile !== "StoreSetupDraftV1" && r.profile !== "StoreSetupDraftV2") ||
      r.currencyCode !== "CAD" ||
      r.purposeCode !== "STORE_SETUP_DRAFT" ||
      r.dataClassification !== "ConfigurationMetadata"
    )
      return fail();
    const content = parseStoreSetupContent(r.content);
    if ((r.profile === "StoreSetupDraftV2") !== Object.hasOwn(content, "feeContexts"))
      return fail();
    const createdAt = instant(r.createdAt),
      updatedAt = instant(r.updatedAt);
    if (updatedAt < createdAt) return fail();
    return Object.freeze({
      profile: r.profile,
      setupDraftReference: ref(r.setupDraftReference),
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      revision: integer(r.revision, 1),
      authoredByReference: ref(r.authoredByReference),
      defaultLocale: locale(r.defaultLocale),
      currencyCode: "CAD",
      baseConfigurationReference: nullableRef(r.baseConfigurationReference),
      content,
      createdAt,
      updatedAt,
      purposeCode: "STORE_SETUP_DRAFT",
      dataClassification: "ConfigurationMetadata",
    });
  });
}
export interface StoreSetupWorkspace {
  readonly profile: "StoreSetupWorkspaceV1";
  readonly scope: StoreSetupScope;
  readonly store: Readonly<{
    storeReference: string;
    code: string;
    displayName: string;
    locale: string;
    currencyCode: "CAD";
    timeZone: string;
    version: number;
  }>;
  readonly setup: Readonly<{
    profile: "StoreSetupCurrentV1";
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    readerActorReference: string;
    snapshot: StoreSetupSnapshot | null;
    observedAt: string;
    validUntil: string;
    businessReferenceValidation: "NotEvaluated";
  }>;
}
const equalScope = (left: StoreSetupScope, right: StoreSetupScope) =>
  canonical(left) === canonical(right);
export function parseStoreSetupWorkspace(
  raw: unknown,
  expectedStore: string,
  expectedScope?: StoreSetupScope,
): StoreSetupWorkspace {
  return safe(() => {
    const r = record(raw, ["profile", "scope", "store", "setup"]),
      scope = parseStoreSetupScope(r.scope),
      s = record(r.store, [
        "storeReference",
        "code",
        "displayName",
        "locale",
        "currencyCode",
        "timeZone",
        "version",
      ]),
      v = record(r.setup, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "readerActorReference",
        "snapshot",
        "observedAt",
        "validUntil",
        "businessReferenceValidation",
      ]);
    if (
      scope.storeReference !== ref(expectedStore) ||
      s.storeReference !== scope.storeReference ||
      (expectedScope && !equalScope(scope, parseStoreSetupScope(expectedScope)))
    )
      return fail("ScopeChanged");
    if (
      r.profile !== "StoreSetupWorkspaceV1" ||
      v.profile !== "StoreSetupCurrentV1" ||
      v.tenantReference !== scope.tenantReference ||
      v.brandReference !== scope.brandReference ||
      v.storeReference !== scope.storeReference ||
      v.readerActorReference !== scope.actorReference ||
      v.businessReferenceValidation !== "NotEvaluated" ||
      s.currencyCode !== "CAD" ||
      typeof s.code !== "string" ||
      !s.code.length ||
      s.code.length > 64 ||
      typeof s.displayName !== "string" ||
      !s.displayName.length ||
      s.displayName.length > 200
    )
      return fail();
    const observedAt = instant(v.observedAt),
      validUntil = instant(v.validUntil);
    if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
      return fail();
    const snapshot = v.snapshot === null ? null : parseStoreSetupSnapshot(v.snapshot);
    if (
      snapshot &&
      (snapshot.tenantReference !== scope.tenantReference ||
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.updatedAt > observedAt)
    )
      return fail();
    return Object.freeze({
      profile: "StoreSetupWorkspaceV1",
      scope,
      store: Object.freeze({
        storeReference: scope.storeReference,
        code: s.code,
        displayName: s.displayName,
        locale: locale(s.locale),
        currencyCode: "CAD",
        timeZone: zone(s.timeZone),
        version: integer(s.version, 1),
      }),
      setup: Object.freeze({
        profile: "StoreSetupCurrentV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        readerActorReference: scope.actorReference,
        snapshot,
        observedAt,
        validUntil,
        businessReferenceValidation: "NotEvaluated",
      }),
    });
  });
}
export interface StoreSetupCursor {
  readonly profile: "StoreSetupPendingOriginalV1";
  readonly scope: StoreSetupScope;
  readonly operationReference: string;
  readonly expectedSetupReference: string | null;
  readonly expectedRevision: number;
  readonly intentDigest: string;
}
export function parseStoreSetupCursor(raw: unknown): StoreSetupCursor {
  return safe(() => {
    const r = record(raw, [
      "profile",
      "scope",
      "operationReference",
      "expectedSetupReference",
      "expectedRevision",
      "intentDigest",
    ]);
    if (r.profile !== "StoreSetupPendingOriginalV1") return fail();
    const expectedSetupReference = nullableRef(r.expectedSetupReference),
      expectedRevision = integer(r.expectedRevision);
    if ((expectedSetupReference === null) !== (expectedRevision === 0)) return fail();
    return Object.freeze({
      profile: "StoreSetupPendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      operationReference: ref(r.operationReference),
      expectedSetupReference,
      expectedRevision,
      intentDigest: digest(r.intentDigest),
    });
  });
}
export interface StoreSetupOriginal extends StoreSetupScope {
  readonly profile: "StoreSetupSaveV1" | "StoreSetupSaveV2";
  readonly operationReference: string;
  readonly expectedSetupReference: string | null;
  readonly expectedRevision: number;
  readonly content: StoreSetupContent;
  readonly purposeCode: "STORE_SETUP_DRAFT";
}
export interface PreparedStoreSetupSave {
  readonly command: StoreSetupOriginal;
  readonly intentDigest: string;
  readonly cursor: StoreSetupCursor;
}
export interface StoreSetupReceipt extends StoreSetupScope {
  readonly profile: "StoreSetupOperationReceiptV1";
  readonly operationReference: string;
  readonly expectedSetupReference: string | null;
  readonly expectedRevision: number;
  readonly purposeCode: "STORE_SETUP_DRAFT";
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: StoreSetupSnapshot | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export function parseStoreSetupReceipt(raw: unknown, cursor: StoreSetupCursor): StoreSetupReceipt {
  return safe(() => {
    const original = parseStoreSetupCursor(cursor),
      r = record(raw, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "operationReference",
        "expectedSetupReference",
        "expectedRevision",
        "purposeCode",
        "intentDigest",
        "outcome",
        "snapshot",
        "auditReference",
        "occurredAt",
      ]),
      scope = parseStoreSetupScope({
        tenantReference: r.tenantReference,
        brandReference: r.brandReference,
        storeReference: r.storeReference,
        actorReference: r.actorReference,
      });
    if (!equalScope(scope, original.scope)) return fail("ScopeChanged");
    if (
      r.profile !== "StoreSetupOperationReceiptV1" ||
      r.operationReference !== original.operationReference ||
      r.expectedSetupReference !== original.expectedSetupReference ||
      r.expectedRevision !== original.expectedRevision ||
      r.intentDigest !== original.intentDigest ||
      r.purposeCode !== "STORE_SETUP_DRAFT" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return fail();
    const snapshot = r.snapshot === null ? null : parseStoreSetupSnapshot(r.snapshot),
      occurredAt = instant(r.occurredAt);
    if ((r.outcome === "Abandoned") !== (snapshot === null)) return fail();
    if (
      snapshot &&
      (snapshot.tenantReference !== scope.tenantReference ||
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.authoredByReference !== scope.actorReference ||
        snapshot.revision !== original.expectedRevision + 1 ||
        snapshot.updatedAt !== occurredAt ||
        (original.expectedSetupReference !== null &&
          snapshot.setupDraftReference !== original.expectedSetupReference) ||
        (original.expectedRevision === 0 && snapshot.createdAt !== occurredAt))
    )
      return fail();
    return Object.freeze({
      profile: "StoreSetupOperationReceiptV1",
      ...scope,
      operationReference: original.operationReference,
      expectedSetupReference: original.expectedSetupReference,
      expectedRevision: original.expectedRevision,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest: original.intentDigest,
      outcome: r.outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
}
export async function validateStoreSetupReceipt(
  raw: unknown,
  cursor: StoreSetupCursor,
): Promise<StoreSetupReceipt> {
  const receipt = parseStoreSetupReceipt(raw, cursor);
  if (receipt.snapshot) {
    const reconstructed = {
      profile:
        receipt.snapshot.profile === "StoreSetupDraftV2" ? "StoreSetupSaveV2" : "StoreSetupSaveV1",
      tenantReference: receipt.tenantReference,
      brandReference: receipt.brandReference,
      storeReference: receipt.storeReference,
      actorReference: receipt.actorReference,
      operationReference: receipt.operationReference,
      expectedSetupReference: receipt.expectedSetupReference,
      expectedRevision: receipt.expectedRevision,
      content: receipt.snapshot.content,
      purposeCode: "STORE_SETUP_DRAFT",
    };
    if ((await publicationValueDigest(reconstructed)) !== receipt.intentDigest) return fail();
  }
  return receipt;
}

interface RequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}
export function createStoreSetupClient(fetcher: typeof fetch = fetch) {
  let key = "",
    epoch = 0;
  const request = async (
    store: string,
    scope: StoreSetupScope | undefined,
    options: RequestOptions,
    body?: unknown,
    classificationRead = false,
  ) => {
    const csrf = options.csrf,
      signal = options.signal;
    const current = canonical({ store, scope: scope ?? null, csrf: options.csrf });
    if (current !== key) {
      key = current;
      epoch++;
    }
    const captured = epoch;
    if (body !== undefined && (typeof options.csrf !== "string" || !options.csrf)) return fail();
    if (options.signal?.aborted) return fail("Unavailable");
    const controller = new AbortController(),
      abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let sent = false;
    try {
      const encoded = body === undefined ? undefined : canonical(body);
      if (encoded !== undefined && new TextEncoder().encode(encoded).length > 2097152)
        return fail();
      sent = true;
      const response = await fetcher(
        `/merchant/store-setup${classificationRead ? "/fee-context-classifications" : ""}${body === undefined ? `?storeReference=${ref(store)}` : ""}`,
        {
          method: body === undefined ? "GET" : "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(options.csrf ? { "X-BOP-CSRF": options.csrf } : {}),
            ...((body !== undefined || classificationRead) && scope
              ? {
                  "X-BOP-Store-Setup-Scope": btoa(canonical(scope))
                    .replace(/\+/gu, "-")
                    .replace(/\//gu, "_")
                    .replace(/=+$/u, ""),
                }
              : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(encoded === undefined ? {} : { body: encoded }),
        },
      );
      if (captured !== epoch || options.csrf !== csrf || options.signal !== signal)
        return fail("ScopeChanged");
      if (controller.signal.aborted) return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (response.status === 403) return fail("Denied");
      if (response.status === 409) return fail("Conflict");
      if (response.status === 400) return fail("Invalid");
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (!response.body) return fail(body ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      let bytes = 0,
        text = "";
      try {
        if (controller.signal.aborted) cancel();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4194304) return fail(body ? "OutcomeUnknown" : "Unavailable");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (controller.signal.aborted) return fail(body ? "OutcomeUnknown" : "Unavailable");
      if (captured !== epoch || options.csrf !== csrf || options.signal !== signal)
        return fail("ScopeChanged");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof StoreSetupClientError) throw error;
      return fail(body && sent ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
  return Object.freeze({
    async load(
      input: RequestOptions & { storeReference: string; expectedScope?: StoreSetupScope },
    ) {
      const store = safe(() => ref(input.storeReference)),
        scope = input.expectedScope ? parseStoreSetupScope(input.expectedScope) : undefined;
      const workspace = parseStoreSetupWorkspace(await request(store, scope, input), store, scope);
      if (Date.now() >= Date.parse(workspace.setup.validUntil)) return fail("Stale");
      return workspace;
    },
    async classifications(input: {
      storeReference: string;
      expectedScope: StoreSetupScope;
      signal?: AbortSignal;
    }) {
      const scope = parseStoreSetupScope(input.expectedScope),
        store = ref(input.storeReference);
      if (store !== scope.storeReference) return fail("ScopeChanged");
      const raw = await request(store, scope, input, undefined, true);
      try {
        return parseTaxConfigClassificationChoices(raw, scope);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ScopeChanged")
          return fail("ScopeChanged");
        return fail();
      }
    },
    async prepare(input: {
      expectedScope: StoreSetupScope;
      operationReference: string;
      expectedSetupReference: string | null;
      expectedRevision: number;
      content: unknown;
    }): Promise<PreparedStoreSetupSave> {
      const command = safe(() => {
        const r = record(input, [
            "expectedScope",
            "operationReference",
            "expectedSetupReference",
            "expectedRevision",
            "content",
          ]),
          scope = parseStoreSetupScope(r.expectedScope),
          operationReference = ref(r.operationReference),
          expectedSetupReference = nullableRef(r.expectedSetupReference),
          expectedRevision = integer(r.expectedRevision);
        if (
          (expectedSetupReference === null) !== (expectedRevision === 0) ||
          expectedRevision === 2147483647
        )
          return fail();
        const content = parseStoreSetupContent(r.content);
        return Object.freeze({
          profile: Object.hasOwn(content, "feeContexts")
            ? ("StoreSetupSaveV2" as const)
            : ("StoreSetupSaveV1" as const),
          ...scope,
          operationReference,
          expectedSetupReference,
          expectedRevision,
          content,
          purposeCode: "STORE_SETUP_DRAFT" as const,
        });
      });
      const intentDigest = await publicationValueDigest(command),
        cursor = parseStoreSetupCursor({
          profile: "StoreSetupPendingOriginalV1",
          scope: {
            tenantReference: command.tenantReference,
            brandReference: command.brandReference,
            storeReference: command.storeReference,
            actorReference: command.actorReference,
          },
          operationReference: command.operationReference,
          expectedSetupReference: command.expectedSetupReference,
          expectedRevision: command.expectedRevision,
          intentDigest,
        });
      return Object.freeze({ command, intentDigest, cursor });
    },
    async execute(prepared: PreparedStoreSetupSave, options: RequestOptions & { csrf: string }) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const r = safe(() => record(prepared, ["command", "intentDigest", "cursor"])),
        cursor = parseStoreSetupCursor(r.cursor);
      const command = safe(() => {
        const v = record(r.command, [
          "profile",
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
          "operationReference",
          "expectedSetupReference",
          "expectedRevision",
          "content",
          "purposeCode",
        ]);
        if (
          (v.profile !== "StoreSetupSaveV1" && v.profile !== "StoreSetupSaveV2") ||
          v.purposeCode !== "STORE_SETUP_DRAFT" ||
          v.operationReference !== cursor.operationReference ||
          v.expectedSetupReference !== cursor.expectedSetupReference ||
          v.expectedRevision !== cursor.expectedRevision
        )
          return fail();
        const scope = parseStoreSetupScope({
          tenantReference: v.tenantReference,
          brandReference: v.brandReference,
          storeReference: v.storeReference,
          actorReference: v.actorReference,
        });
        if (!equalScope(scope, cursor.scope)) return fail("ScopeChanged");
        const content = parseStoreSetupContent(v.content);
        if ((v.profile === "StoreSetupSaveV2") !== Object.hasOwn(content, "feeContexts"))
          return fail();
        return Object.freeze({
          profile: v.profile,
          ...scope,
          operationReference: cursor.operationReference,
          expectedSetupReference: cursor.expectedSetupReference,
          expectedRevision: cursor.expectedRevision,
          content,
          purposeCode: "STORE_SETUP_DRAFT",
        });
      });
      if (
        (await publicationValueDigest(command)) !== cursor.intentDigest ||
        r.intentDigest !== cursor.intentDigest
      )
        return fail();
      const body = {
        command: "SaveDraft",
        operationReference: cursor.operationReference,
        expectedSetupReference: cursor.expectedSetupReference,
        expectedRevision: cursor.expectedRevision,
        content: command.content,
      };
      const raw = await request(cursor.scope.storeReference, cursor.scope, options, body);
      const receivedEpoch = epoch;
      try {
        const receipt = await validateStoreSetupReceipt(raw, cursor);
        if (
          receivedEpoch !== epoch ||
          options.csrf !== attemptCsrf ||
          options.signal !== attemptSignal
        )
          return fail("ScopeChanged");
        if (attemptSignal?.aborted) return fail("OutcomeUnknown");
        return receipt;
      } catch (error) {
        if (error instanceof StoreSetupClientError && error.code === "ScopeChanged") throw error;
        return fail("OutcomeUnknown");
      }
    },
    async resolve(value: StoreSetupCursor, options: RequestOptions & { csrf: string }) {
      const attemptCsrf = options.csrf,
        attemptSignal = options.signal;
      const cursor = parseStoreSetupCursor(value);
      const raw = await request(cursor.scope.storeReference, cursor.scope, options, {
        command: "ResolveOriginal",
        operationReference: cursor.operationReference,
        expectedSetupReference: cursor.expectedSetupReference,
        expectedRevision: cursor.expectedRevision,
        intentDigest: cursor.intentDigest,
      });
      const receivedEpoch = epoch;
      try {
        const receipt = await validateStoreSetupReceipt(raw, cursor);
        if (
          receivedEpoch !== epoch ||
          options.csrf !== attemptCsrf ||
          options.signal !== attemptSignal
        )
          return fail("ScopeChanged");
        if (attemptSignal?.aborted) return fail("OutcomeUnknown");
        return receipt;
      } catch (error) {
        if (error instanceof StoreSetupClientError && error.code === "ScopeChanged") throw error;
        return fail("OutcomeUnknown");
      }
    },
  });
}
