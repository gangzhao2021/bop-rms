/**
 * WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): what the Store's Owner entered for customer
 * receipts and the privacy notice. Every field is optional: a Store not registered for a tax prints
 * no number for it, and a Store without a privacy notice link shows customers no link. The system
 * never infers or invents a legal fact; it checks only the shape the tax authority publishes:
 *
 * - GST/HST (Canada Revenue Agency): 9-digit Business Number + "RT" + 4-digit account, e.g.
 *   `123456789RT0001` (spaces are removed on entry).
 * - QST (Revenu Québec): 10 digits + "TQ" + 4 digits, e.g. `1234567890TQ0001`.
 * - PST (BC, SK, MB): the provincial number as issued (letters, digits, spaces and hyphens).
 * - Privacy notice: an `https://` link to the Store's own notice (no user name or password in it).
 */
export interface StoreReceiptProfileDetails {
  readonly gstHstNumber: string | null;
  readonly qstNumber: string | null;
  readonly pstNumber: string | null;
  readonly privacyNoticeUrl: string | null;
}

export interface StoreReceiptProfile extends StoreReceiptProfileDetails {
  readonly version: number;
  readonly recordedAt: string;
}

/** A registration line as printed on a receipt ("GST/HST Reg. No. 123456789RT0001"). */
export interface StoreReceiptTaxRegistration {
  readonly label: "GST/HST" | "QST" | "PST";
  readonly number: string;
}

export class StoreReceiptProfileError extends Error {
  constructor(
    readonly code:
      | "STORE_RECEIPT_PROFILE_INVALID"
      | "STORE_RECEIPT_PROFILE_DENIED"
      | "STORE_RECEIPT_PROFILE_VERSION_CONFLICT"
      | "STORE_RECEIPT_PROFILE_NO_CHANGE"
      | "STORE_RECEIPT_PROFILE_OPERATION_CONFLICT"
      | "STORE_RECEIPT_PROFILE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "StoreReceiptProfileError";
  }
}

const invalid = (): never => {
  throw new StoreReceiptProfileError("STORE_RECEIPT_PROFILE_INVALID");
};

export const storeReceiptNumberPatterns = Object.freeze({
  gstHstNumber: /^[0-9]{9}RT[0-9]{4}$/u,
  qstNumber: /^[0-9]{10}TQ[0-9]{4}$/u,
  pstNumber: /^[A-Z0-9][A-Z0-9 -]{2,30}[A-Z0-9]$/u,
});

/** Entry form: trimmed, upper-cased; GST/HST and QST lose the spaces people type in. */
function number(value: unknown, field: keyof typeof storeReceiptNumberPatterns): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64) return invalid();
  const upper = value.trim().toUpperCase();
  const normalized =
    field === "pstNumber" ? upper.replace(/\s+/gu, " ") : upper.replace(/\s/gu, "");
  if (normalized === "") return null;
  return storeReceiptNumberPatterns[field].test(normalized) ? normalized : invalid();
}

export function parsePrivacyNoticeUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500) return invalid();
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length < 12 || /[\s<>"]/u.test(trimmed)) return invalid();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !/^[A-Za-z0-9.-]+$/u.test(url.hostname) ||
    !url.hostname.includes(".") ||
    !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s<>"]*)?$/u.test(trimmed)
  )
    return invalid();
  return trimmed;
}

export function parseStoreReceiptProfileDetails(value: unknown): StoreReceiptProfileDetails {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = ["gstHstNumber", "qstNumber", "pstNumber", "privacyNoticeUrl"];
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    gstHstNumber: number(raw.gstHstNumber, "gstHstNumber"),
    qstNumber: number(raw.qstNumber, "qstNumber"),
    pstNumber: number(raw.pstNumber, "pstNumber"),
    privacyNoticeUrl: parsePrivacyNoticeUrl(raw.privacyNoticeUrl),
  });
}

/** The registration lines a receipt prints, in a fixed order; none when nothing was entered. */
export function storeReceiptTaxRegistrations(
  details: StoreReceiptProfileDetails | null,
): readonly StoreReceiptTaxRegistration[] {
  if (details === null) return Object.freeze([]);
  const lines: StoreReceiptTaxRegistration[] = [];
  if (details.gstHstNumber !== null)
    lines.push(Object.freeze({ label: "GST/HST", number: details.gstHstNumber }));
  if (details.qstNumber !== null)
    lines.push(Object.freeze({ label: "QST", number: details.qstNumber }));
  if (details.pstNumber !== null)
    lines.push(Object.freeze({ label: "PST", number: details.pstNumber }));
  return Object.freeze(lines);
}

/** What staff still need to enter before receipts and checkout are complete for customers. */
export function storeReceiptProfileSetupGaps(details: StoreReceiptProfileDetails | null) {
  return Object.freeze({
    taxRegistrationMissing:
      details === null ||
      (details.gstHstNumber === null && details.qstNumber === null && details.pstNumber === null),
    privacyNoticeMissing: details === null || details.privacyNoticeUrl === null,
  });
}
