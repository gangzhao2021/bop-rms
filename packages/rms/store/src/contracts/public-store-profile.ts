import type { EffectiveConfigurationVersion } from "@bop/effective-period";
import type { MediaAsset, MediaAssetVersion, MediaReference } from "@bop/media";
import type { PublishingLifecycleRecord, PublishingReleaseRecord } from "@bop/publishing";
import {
  parseBrandReference,
  parseCanonicalInstant,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type OrganizationLifecycle,
  type StoreReference,
} from "@bop/tenant";

export type PublicStoreReference = string & { readonly __publicStoreReference: unique symbol };
export type StoreProfileReference = string & { readonly __storeProfileReference: unique symbol };
export type StoreEvidenceReference = string & { readonly __storeEvidenceReference: unique symbol };
export type StoreContentDigest = string & { readonly __storeContentDigest: unique symbol };
export type StoreProfileVersion = number & { readonly __storeProfileVersion: unique symbol };
export type StoreLocale = string & { readonly __storeLocale: unique symbol };

export interface GetPublicStoreRequest {
  readonly publicStoreReference: PublicStoreReference;
  readonly requestedLocale: StoreLocale;
  readonly evaluatedAt: CanonicalInstant;
  readonly purpose: "CustomerEntry";
}

export interface PublicStoreResolutionEvidence {
  readonly publicStoreReference: PublicStoreReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly brandLifecycle: OrganizationLifecycle;
  readonly storeLifecycle: OrganizationLifecycle;
  readonly lookupEvidenceReference: StoreEvidenceReference;
  readonly validUntil: CanonicalInstant;
}

export interface LocalizedPublicStoreFields {
  readonly brandDisplayName: string;
  readonly storeDisplayName: string;
}

export interface PublicStoreAddress {
  readonly countryCode: string;
  readonly regionCode: string;
  readonly locality: string;
  readonly postalCode: string;
  readonly addressLines: readonly string[];
}

export interface PublicStoreLogoEvidence {
  readonly reference: MediaReference;
  readonly asset: MediaAsset;
  readonly version: MediaAssetVersion;
}

export interface PublicStoreProfileCandidate {
  readonly profileReference: StoreProfileReference;
  readonly profileVersion: StoreProfileVersion;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly classification: "Public";
  readonly defaultLocale: StoreLocale;
  readonly supportedLocales: readonly StoreLocale[];
  readonly localizedFields: Readonly<Record<string, LocalizedPublicStoreFields>>;
  readonly currencyCode: "CAD";
  readonly timeZone: string;
  readonly address: PublicStoreAddress;
  readonly businessPhone: string | null;
  readonly website: string | null;
  readonly contentDigest: StoreContentDigest;
  readonly publishingLifecycle: PublishingLifecycleRecord;
  readonly publishingRelease: PublishingReleaseRecord;
  readonly effectiveVersion: EffectiveConfigurationVersion;
  readonly logo: PublicStoreLogoEvidence | null;
}

export interface PublicStoreProfile {
  readonly profileReference: StoreProfileReference;
  readonly profileVersion: StoreProfileVersion;
  readonly releaseReference: string;
  readonly contentDigest: StoreContentDigest;
  readonly defaultLocale: StoreLocale;
  readonly selectedLocale: StoreLocale;
  readonly currencyCode: "CAD";
  readonly timeZone: string;
  readonly brandDisplayName: string;
  readonly storeDisplayName: string;
  readonly address: PublicStoreAddress;
  readonly businessPhone: string | null;
  readonly website: string | null;
  readonly logoAssetVersionReference: string | null;
}

export type GetPublicStoreResult =
  | Readonly<{ status: "Available"; profile: PublicStoreProfile }>
  | Readonly<{ status: "InvalidRequest" }>
  | Readonly<{ status: "StoreUnavailable" }>;

export const storeContractErrorCodes = [
  "STORE_REQUEST_INVALID",
  "STORE_EVIDENCE_INVALID",
  "STORE_PROFILE_INVALID",
] as const;
export type StoreContractErrorCode = (typeof storeContractErrorCodes)[number];

export class StoreContractError extends Error {
  readonly code: StoreContractErrorCode;

  constructor(code: StoreContractErrorCode) {
    super("store public profile contract is invalid");
    this.name = "StoreContractError";
    this.code = code;
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const locale = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const plainTextForbidden = /[<>{}[\]`*_#]/u;
const countryCode = /^[A-Z]{2}$/u;
const regionCode = /^[A-Z0-9][A-Z0-9-]{0,15}$/u;
const postalCode = /^[A-Z0-9][A-Z0-9 -]{0,15}$/u;
const e164 = /^\+[1-9]\d{7,14}$/u;

function fail(code: StoreContractErrorCode): never {
  throw new StoreContractError(code);
}

export function readExactRecord(
  value: unknown,
  fields: readonly string[],
  code: StoreContractErrorCode,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail(code);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    return fail(code);
  return value as Readonly<Record<string, unknown>>;
}

function parseUuid<T extends string>(value: unknown, code: StoreContractErrorCode): T {
  if (typeof value !== "string" || !uuidV7.test(value)) return fail(code);
  return value as T;
}

function parseLocale(value: unknown, code: StoreContractErrorCode): StoreLocale {
  if (typeof value !== "string" || !locale.test(value)) return fail(code);
  return value as StoreLocale;
}

function parseInstant(value: unknown, code: StoreContractErrorCode): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return fail(code);
  }
}

function parseText(value: unknown, maximum: number, code: StoreContractErrorCode): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    plainTextForbidden.test(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  )
    return fail(code);
  return value;
}

function readExactArray(
  value: unknown,
  minimum: number,
  maximum: number,
  code: StoreContractErrorCode,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  )
    return fail(code);
  const indexes = Array.from({ length: value.length }, (_, index) => String(index));
  const expectedKeys = new Set([...indexes, "length"]);
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
    indexes.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    return fail(code);
  return value;
}

function parseTimeZone(value: unknown): string {
  const timeZone = parseText(value, 64, "STORE_PROFILE_INVALID");
  try {
    if (new Intl.DateTimeFormat("en-CA", { timeZone }).resolvedOptions().timeZone !== timeZone)
      return fail("STORE_PROFILE_INVALID");
  } catch {
    return fail("STORE_PROFILE_INVALID");
  }
  return timeZone;
}

function parseWebsite(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 512 || value.trim() !== value)
    return fail("STORE_PROFILE_INVALID");
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.hostname === "" ||
      parsed.toString() !== value
    )
      return fail("STORE_PROFILE_INVALID");
  } catch {
    return fail("STORE_PROFILE_INVALID");
  }
  return value;
}

function parseAddress(value: unknown): PublicStoreAddress {
  const input = readExactRecord(
    value,
    ["countryCode", "regionCode", "locality", "postalCode", "addressLines"],
    "STORE_PROFILE_INVALID",
  );
  if (
    typeof input.countryCode !== "string" ||
    !countryCode.test(input.countryCode) ||
    typeof input.regionCode !== "string" ||
    !regionCode.test(input.regionCode) ||
    typeof input.postalCode !== "string" ||
    !postalCode.test(input.postalCode) ||
    !Array.isArray(input.addressLines)
  )
    return fail("STORE_PROFILE_INVALID");
  const addressLines = readExactArray(input.addressLines, 1, 3, "STORE_PROFILE_INVALID");
  return Object.freeze({
    countryCode: input.countryCode,
    regionCode: input.regionCode,
    locality: parseText(input.locality, 96, "STORE_PROFILE_INVALID"),
    postalCode: input.postalCode,
    addressLines: Object.freeze(
      addressLines.map((line) => parseText(line, 160, "STORE_PROFILE_INVALID")),
    ),
  });
}

function parseLocalizedFields(
  value: unknown,
  supportedLocales: readonly StoreLocale[],
): Readonly<Record<string, LocalizedPublicStoreFields>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("STORE_PROFILE_INVALID");
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== supportedLocales.length ||
    keys.some((key) => typeof key !== "string" || !supportedLocales.includes(key as StoreLocale)) ||
    supportedLocales.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    return fail("STORE_PROFILE_INVALID");
  const output: Record<string, LocalizedPublicStoreFields> = {};
  for (const key of supportedLocales) {
    const fields = readExactRecord(
      (value as Record<string, unknown>)[key],
      ["brandDisplayName", "storeDisplayName"],
      "STORE_PROFILE_INVALID",
    );
    output[key] = Object.freeze({
      brandDisplayName: parseText(fields.brandDisplayName, 120, "STORE_PROFILE_INVALID"),
      storeDisplayName: parseText(fields.storeDisplayName, 120, "STORE_PROFILE_INVALID"),
    });
  }
  return Object.freeze(output);
}

export function parseGetPublicStoreRequest(value: unknown): GetPublicStoreRequest {
  const input = readExactRecord(
    value,
    ["publicStoreReference", "requestedLocale", "evaluatedAt", "purpose"],
    "STORE_REQUEST_INVALID",
  );
  if (input.purpose !== "CustomerEntry") return fail("STORE_REQUEST_INVALID");
  return Object.freeze({
    publicStoreReference: parseUuid<PublicStoreReference>(
      input.publicStoreReference,
      "STORE_REQUEST_INVALID",
    ),
    requestedLocale: parseLocale(input.requestedLocale, "STORE_REQUEST_INVALID"),
    evaluatedAt: parseInstant(input.evaluatedAt, "STORE_REQUEST_INVALID"),
    purpose: "CustomerEntry",
  });
}

export function parsePublicStoreResolutionEvidence(value: unknown): PublicStoreResolutionEvidence {
  const input = readExactRecord(
    value,
    [
      "publicStoreReference",
      "brandReference",
      "storeReference",
      "brandLifecycle",
      "storeLifecycle",
      "lookupEvidenceReference",
      "validUntil",
    ],
    "STORE_EVIDENCE_INVALID",
  );
  if (
    !["Draft", "Active", "Suspended", "Archived"].includes(input.brandLifecycle as string) ||
    !["Draft", "Active", "Suspended", "Archived"].includes(input.storeLifecycle as string)
  )
    return fail("STORE_EVIDENCE_INVALID");
  try {
    return Object.freeze({
      publicStoreReference: parseUuid<PublicStoreReference>(
        input.publicStoreReference,
        "STORE_EVIDENCE_INVALID",
      ),
      brandReference: parseBrandReference(input.brandReference),
      storeReference: parseStoreReference(input.storeReference),
      brandLifecycle: input.brandLifecycle as OrganizationLifecycle,
      storeLifecycle: input.storeLifecycle as OrganizationLifecycle,
      lookupEvidenceReference: parseUuid<StoreEvidenceReference>(
        input.lookupEvidenceReference,
        "STORE_EVIDENCE_INVALID",
      ),
      validUntil: parseInstant(input.validUntil, "STORE_EVIDENCE_INVALID"),
    });
  } catch {
    return fail("STORE_EVIDENCE_INVALID");
  }
}

export function parsePublicStoreProfileCandidateShape(value: unknown): PublicStoreProfileCandidate {
  const input = readExactRecord(
    value,
    [
      "profileReference",
      "profileVersion",
      "brandReference",
      "storeReference",
      "classification",
      "defaultLocale",
      "supportedLocales",
      "localizedFields",
      "currencyCode",
      "timeZone",
      "address",
      "businessPhone",
      "website",
      "contentDigest",
      "publishingLifecycle",
      "publishingRelease",
      "effectiveVersion",
      "logo",
    ],
    "STORE_PROFILE_INVALID",
  );
  if (
    input.classification !== "Public" ||
    input.currencyCode !== "CAD" ||
    !Number.isSafeInteger(input.profileVersion) ||
    (input.profileVersion as number) < 1 ||
    !Array.isArray(input.supportedLocales)
  )
    return fail("STORE_PROFILE_INVALID");
  const supportedLocaleValues = readExactArray(
    input.supportedLocales,
    1,
    12,
    "STORE_PROFILE_INVALID",
  );
  const supportedLocales = supportedLocaleValues.map((item) =>
    parseLocale(item, "STORE_PROFILE_INVALID"),
  );
  if (
    new Set(supportedLocales).size !== supportedLocales.length ||
    [...supportedLocales].sort().some((item, index) => item !== supportedLocales[index])
  )
    return fail("STORE_PROFILE_INVALID");
  const defaultLocale = parseLocale(input.defaultLocale, "STORE_PROFILE_INVALID");
  if (!supportedLocales.includes(defaultLocale)) return fail("STORE_PROFILE_INVALID");
  let brandReference: BrandReference;
  let storeReference: StoreReference;
  try {
    brandReference = parseBrandReference(input.brandReference);
    storeReference = parseStoreReference(input.storeReference);
  } catch {
    return fail("STORE_PROFILE_INVALID");
  }
  if (
    input.businessPhone !== null &&
    (typeof input.businessPhone !== "string" || !e164.test(input.businessPhone))
  )
    return fail("STORE_PROFILE_INVALID");
  if (typeof input.contentDigest !== "string" || !digest.test(input.contentDigest))
    return fail("STORE_PROFILE_INVALID");
  return Object.freeze({
    profileReference: parseUuid<StoreProfileReference>(
      input.profileReference,
      "STORE_PROFILE_INVALID",
    ),
    profileVersion: input.profileVersion as StoreProfileVersion,
    brandReference,
    storeReference,
    classification: "Public",
    defaultLocale,
    supportedLocales: Object.freeze(supportedLocales),
    localizedFields: parseLocalizedFields(input.localizedFields, supportedLocales),
    currencyCode: "CAD",
    timeZone: parseTimeZone(input.timeZone),
    address: parseAddress(input.address),
    businessPhone: input.businessPhone as string | null,
    website: parseWebsite(input.website),
    contentDigest: input.contentDigest as StoreContentDigest,
    publishingLifecycle: input.publishingLifecycle as PublishingLifecycleRecord,
    publishingRelease: input.publishingRelease as PublishingReleaseRecord,
    effectiveVersion: input.effectiveVersion as EffectiveConfigurationVersion,
    logo: input.logo as PublicStoreLogoEvidence | null,
  });
}
