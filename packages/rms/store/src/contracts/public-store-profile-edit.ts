import {
  parseStoreBusinessAddress,
  parseStoreBusinessPhone,
  readExactRecord,
  StoreContractError,
  type PublicStoreAddress,
} from "./public-store-profile.js";

/**
 * WP-2423 store name (DEC-STORE-CUSTOMER-NAME): what the Owner changes in the Store's published
 * public profile — the name customers see in each language the profile supports, the street
 * address and the business phone. Everything else (Brand name, locales, time zone, website, logo)
 * carries over unchanged from the current version.
 */
export interface PublicStoreProfileEdit {
  readonly storeDisplayNames: Readonly<Record<string, string>>;
  readonly address: PublicStoreAddress;
  readonly businessPhone: string | null;
}

export const publicStoreProfileEditErrorCodes = [
  "STORE_PUBLIC_PROFILE_INVALID",
  "STORE_PUBLIC_PROFILE_DENIED",
  "STORE_PUBLIC_PROFILE_VERSION_CONFLICT",
  "STORE_PUBLIC_PROFILE_NO_CHANGE",
  "STORE_PUBLIC_PROFILE_OPERATION_CONFLICT",
  "STORE_PUBLIC_PROFILE_UNAVAILABLE",
] as const;
export type PublicStoreProfileEditErrorCode = (typeof publicStoreProfileEditErrorCodes)[number];

export class PublicStoreProfileEditError extends Error {
  constructor(readonly code: PublicStoreProfileEditErrorCode) {
    super("Store public profile " + code);
    this.name = "PublicStoreProfileEditError";
  }
}
const invalid = (): never => {
  throw new PublicStoreProfileEditError("STORE_PUBLIC_PROFILE_INVALID");
};

/** Canadian provinces and territories (ISO 3166-2:CA subdivision codes). */
export const canadianRegionCodes = [
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
] as const;

/** Accepts what people type ("416-555-0100", "(416) 555 0100", "+1 416 555 0100") for Canada. */
export function normalizeStoreBusinessPhone(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40) return invalid();
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\+?[0-9 ().-]+$/u.test(trimmed)) return invalid();
  const digits = trimmed.replace(/[^0-9]/gu, "");
  let e164: string;
  if (trimmed.startsWith("+")) e164 = "+" + digits;
  else if (digits.length === 10) e164 = "+1" + digits;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = "+" + digits;
  else return invalid();
  // North American numbers: area code and exchange never start with 0 or 1.
  if (e164.startsWith("+1") && !/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(e164)) return invalid();
  try {
    return parseStoreBusinessPhone(e164);
  } catch {
    return invalid();
  }
}

/** "a1a1a1" and "A1A 1A1" become "A1A 1A1" (Canada Post format). */
export function normalizeCanadianPostalCode(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const compact = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/gu, "");
  if (!/^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z][0-9][ABCEGHJ-NPRSTV-Z][0-9]$/u.test(compact))
    return invalid();
  return compact.slice(0, 3) + " " + compact.slice(3);
}

// The public profile's plain-text rule: no markup characters and no control characters.
const markup = /[<>{}[\]`*_#]/u;
const collapse = (value: unknown, maximum: number): string => {
  if (typeof value !== "string") return invalid();
  const text = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (
    text.length < 1 ||
    text.length > maximum ||
    markup.test(text) ||
    [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  )
    return invalid();
  return text;
};

/**
 * The Owner's edit for a profile with `supportedLocales` (one name per language, no more, no
 * fewer). Text follows the public profile contract (plain text, no markup characters).
 */
export function parsePublicStoreProfileEdit(
  value: unknown,
  supportedLocales: readonly string[],
): PublicStoreProfileEdit {
  try {
    const input = readExactRecord(
      value,
      ["storeDisplayNames", "address", "businessPhone"],
      "STORE_PROFILE_INVALID",
    );
    const names = readExactRecord(
      input.storeDisplayNames,
      supportedLocales,
      "STORE_PROFILE_INVALID",
    );
    const storeDisplayNames: Record<string, string> = {};
    for (const locale of supportedLocales) storeDisplayNames[locale] = collapse(names[locale], 120);
    const raw = readExactRecord(
      input.address,
      ["addressLines", "locality", "regionCode", "postalCode"],
      "STORE_PROFILE_INVALID",
    );
    if (!Array.isArray(raw.addressLines) || raw.addressLines.length > 3) return invalid();
    const addressLines = (raw.addressLines as unknown[])
      .map((line) => (typeof line === "string" ? line.replace(/\s+/gu, " ").trim() : invalid()))
      .filter((line) => line !== "")
      .map((line) => collapse(line, 160));
    if (
      typeof raw.regionCode !== "string" ||
      !(canadianRegionCodes as readonly string[]).includes(raw.regionCode)
    )
      return invalid();
    const address = parseStoreBusinessAddress({
      countryCode: "CA",
      regionCode: raw.regionCode,
      locality: collapse(raw.locality, 96),
      postalCode: normalizeCanadianPostalCode(raw.postalCode),
      addressLines,
    });
    return Object.freeze({
      storeDisplayNames: Object.freeze(storeDisplayNames),
      address,
      businessPhone: normalizeStoreBusinessPhone(input.businessPhone),
    });
  } catch (error) {
    if (error instanceof PublicStoreProfileEditError) throw error;
    if (error instanceof StoreContractError) return invalid();
    return invalid();
  }
}
