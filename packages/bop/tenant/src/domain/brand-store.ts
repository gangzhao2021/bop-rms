export const organizationErrorCodes = [
  "ORGANIZATION_INPUT_INVALID",
  "BRAND_REFERENCE_INVALID",
  "STORE_REFERENCE_INVALID",
  "BRAND_SHAPE_INVALID",
  "STORE_SHAPE_INVALID",
  "ORGANIZATION_VERSION_CONFLICT",
  "ORGANIZATION_TRANSITION_INVALID",
] as const;
export type OrganizationErrorCode = (typeof organizationErrorCodes)[number];

const safeMessages: Readonly<Record<OrganizationErrorCode, string>> = {
  ORGANIZATION_INPUT_INVALID: "organization input is invalid",
  BRAND_REFERENCE_INVALID: "brand reference is invalid",
  STORE_REFERENCE_INVALID: "store reference is invalid",
  BRAND_SHAPE_INVALID: "brand shape is invalid",
  STORE_SHAPE_INVALID: "store shape is invalid",
  ORGANIZATION_VERSION_CONFLICT: "organization version conflict",
  ORGANIZATION_TRANSITION_INVALID: "organization transition is invalid",
};

export class OrganizationContractError extends Error {
  readonly code: OrganizationErrorCode;
  constructor(code: OrganizationErrorCode) {
    super(safeMessages[code]);
    this.name = "OrganizationContractError";
    this.code = code;
  }
}

export type BrandReference = string & { readonly __brandReference: unique symbol };
export type StoreReference = string & { readonly __storeReference: unique symbol };
export type OrganizationVersion = number & { readonly __organizationVersion: unique symbol };
export type CanonicalInstant = string & { readonly __canonicalInstant: unique symbol };
export const organizationLifecycles = ["Draft", "Active", "Suspended", "Archived"] as const;
export type OrganizationLifecycle = (typeof organizationLifecycles)[number];

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const codePattern = /^[A-Z][A-Z0-9_-]{0,62}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u;

export function parseBrandReference(value: unknown): BrandReference {
  if (typeof value !== "string" || !uuidV7Pattern.test(value))
    throw new OrganizationContractError("BRAND_REFERENCE_INVALID");
  return value as BrandReference;
}
export function parseStoreReference(value: unknown): StoreReference {
  if (typeof value !== "string" || !uuidV7Pattern.test(value))
    throw new OrganizationContractError("STORE_REFERENCE_INVALID");
  return value as StoreReference;
}
export function parseCanonicalInstant(value: unknown): CanonicalInstant {
  if (typeof value !== "string" || !instantPattern.test(value))
    throw new OrganizationContractError("ORGANIZATION_INPUT_INVALID");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new OrganizationContractError("ORGANIZATION_INPUT_INVALID");
  return value as CanonicalInstant;
}
export function parseOrganizationVersion(value: unknown): OrganizationVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new OrganizationContractError("ORGANIZATION_INPUT_INVALID");
  return value as OrganizationVersion;
}

function readClosedRecord(
  value: unknown,
  keys: readonly string[],
  code: OrganizationErrorCode,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new OrganizationContractError(code);
    const ownKeys = Reflect.ownKeys(value);
    const allowed = new Set(keys);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
    )
      throw new OrganizationContractError(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new OrganizationContractError(code);
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof OrganizationContractError) throw error;
    throw new OrganizationContractError(code);
  }
}

function text(value: unknown, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    (pattern && !pattern.test(value))
  )
    throw new OrganizationContractError("ORGANIZATION_INPUT_INVALID");
  return value;
}
function lifecycle(value: unknown): OrganizationLifecycle {
  if (typeof value !== "string" || !organizationLifecycles.includes(value as OrganizationLifecycle))
    throw new OrganizationContractError("ORGANIZATION_INPUT_INVALID");
  return value as OrganizationLifecycle;
}
function timeZone(value: unknown): string {
  const zone = text(value, 64);
  try {
    if (new Intl.DateTimeFormat("en-CA", { timeZone: zone }).resolvedOptions().timeZone !== zone)
      throw new Error();
  } catch {
    throw new OrganizationContractError("STORE_SHAPE_INVALID");
  }
  return zone;
}

export interface Brand {
  readonly brandReference: BrandReference;
  readonly code: string;
  readonly displayName: string;
  readonly defaultLocale: string;
  readonly currencyCode: "CAD";
  readonly lifecycle: OrganizationLifecycle;
  readonly version: OrganizationVersion;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
}
export interface Store {
  readonly storeReference: StoreReference;
  readonly brandReference: BrandReference;
  readonly code: string;
  readonly displayName: string;
  readonly timeZone: string;
  readonly locale: string;
  readonly currencyCode: "CAD";
  readonly lifecycle: OrganizationLifecycle;
  readonly version: OrganizationVersion;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
}

export function createBrand(value: unknown): Brand {
  const r = readClosedRecord(
    value,
    [
      "brandReference",
      "code",
      "displayName",
      "defaultLocale",
      "currencyCode",
      "lifecycle",
      "version",
      "createdAt",
      "updatedAt",
    ],
    "BRAND_SHAPE_INVALID",
  );
  const createdAt = parseCanonicalInstant(r.createdAt);
  const updatedAt = parseCanonicalInstant(r.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt) || r.currencyCode !== "CAD")
    throw new OrganizationContractError("BRAND_SHAPE_INVALID");
  return Object.freeze({
    brandReference: parseBrandReference(r.brandReference),
    code: text(r.code, 63, codePattern),
    displayName: text(r.displayName, 160),
    defaultLocale: text(r.defaultLocale, 35, localePattern),
    currencyCode: "CAD",
    lifecycle: lifecycle(r.lifecycle),
    version: parseOrganizationVersion(r.version),
    createdAt,
    updatedAt,
  });
}

export function createStore(value: unknown): Store {
  const r = readClosedRecord(
    value,
    [
      "storeReference",
      "brandReference",
      "code",
      "displayName",
      "timeZone",
      "locale",
      "currencyCode",
      "lifecycle",
      "version",
      "createdAt",
      "updatedAt",
    ],
    "STORE_SHAPE_INVALID",
  );
  const createdAt = parseCanonicalInstant(r.createdAt);
  const updatedAt = parseCanonicalInstant(r.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt) || r.currencyCode !== "CAD")
    throw new OrganizationContractError("STORE_SHAPE_INVALID");
  return Object.freeze({
    storeReference: parseStoreReference(r.storeReference),
    brandReference: parseBrandReference(r.brandReference),
    code: text(r.code, 63, codePattern),
    displayName: text(r.displayName, 160),
    timeZone: timeZone(r.timeZone),
    locale: text(r.locale, 35, localePattern),
    currencyCode: "CAD",
    lifecycle: lifecycle(r.lifecycle),
    version: parseOrganizationVersion(r.version),
    createdAt,
    updatedAt,
  });
}

const transitions: Readonly<Record<OrganizationLifecycle, readonly OrganizationLifecycle[]>> = {
  Draft: ["Active", "Archived"],
  Active: ["Suspended", "Archived"],
  Suspended: ["Active", "Archived"],
  Archived: [],
};
function transition<T extends Brand | Store>(
  aggregate: T,
  expectedVersion: OrganizationVersion,
  next: OrganizationLifecycle,
  updatedAtInput: unknown,
): T {
  if (aggregate.version !== expectedVersion)
    throw new OrganizationContractError("ORGANIZATION_VERSION_CONFLICT");
  if (!transitions[aggregate.lifecycle].includes(next))
    throw new OrganizationContractError("ORGANIZATION_TRANSITION_INVALID");
  const updatedAt = parseCanonicalInstant(updatedAtInput);
  if (Date.parse(updatedAt) < Date.parse(aggregate.updatedAt))
    throw new OrganizationContractError("ORGANIZATION_TRANSITION_INVALID");
  return Object.freeze({
    ...aggregate,
    lifecycle: next,
    version: (aggregate.version + 1) as OrganizationVersion,
    updatedAt,
  }) as unknown as T;
}
export function transitionBrand(
  brand: Brand,
  expectedVersion: OrganizationVersion,
  next: OrganizationLifecycle,
  updatedAt: unknown,
): Brand {
  return transition(brand, expectedVersion, next, updatedAt);
}
export function transitionStore(
  store: Store,
  expectedVersion: OrganizationVersion,
  next: OrganizationLifecycle,
  updatedAt: unknown,
): Store {
  return transition(store, expectedVersion, next, updatedAt);
}
