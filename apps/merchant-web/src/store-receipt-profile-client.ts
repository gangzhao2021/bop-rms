import { t } from "./i18n/i18n.js";
/**
 * WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): the Store's receipt registration numbers and privacy
 * notice link. The browser sends what the Owner typed and the version they saw; Store, actor and
 * time are decided by the server.
 */
export interface StoreReceiptProfileDetails {
  readonly gstHstNumber: string | null;
  readonly qstNumber: string | null;
  readonly pstNumber: string | null;
  readonly privacyNoticeUrl: string | null;
}
export interface StoreReceiptProfileGaps {
  readonly taxRegistrationMissing: boolean;
  readonly privacyNoticeMissing: boolean;
}
export interface StoreReceiptProfileView {
  readonly observedAt: string;
  readonly canChange: boolean;
  readonly version: number;
  readonly recordedAt: string | null;
  readonly details: StoreReceiptProfileDetails;
  readonly gaps: StoreReceiptProfileGaps;
}
export interface StoreReceiptProfileSaveBody {
  readonly expectedVersion: number;
  readonly operationReference: string;
  readonly details: {
    readonly gstHstNumber: string | null;
    readonly qstNumber: string | null;
    readonly pstNumber: string | null;
    readonly privacyNoticeUrl: string | null;
  };
}

export class StoreReceiptProfileClientError extends Error {
  constructor(
    readonly code:
      "PermissionDenied" | "Invalid" | "Conflict" | "NoChange" | "Unavailable" | "OutcomeUnknown",
  ) {
    super(t("Receipt and privacy details are unavailable"));
    this.name = "StoreReceiptProfileClientError";
  }
}
const fail = (code: StoreReceiptProfileClientError["code"]): never => {
  throw new StoreReceiptProfileClientError(code);
};
const nullableText = (value: unknown, maximum: number): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    return fail("Unavailable");
  return value;
};
const flag = (value: unknown): boolean =>
  typeof value === "boolean" ? value : fail("Unavailable");
function parseGaps(value: unknown): StoreReceiptProfileGaps {
  const raw = value as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return fail("Unavailable");
  return Object.freeze({
    taxRegistrationMissing: flag(raw.taxRegistrationMissing),
    privacyNoticeMissing: flag(raw.privacyNoticeMissing),
  });
}

export function parseStoreReceiptProfileView(value: unknown): StoreReceiptProfileView {
  const raw = value as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return fail("Unavailable");
  const details = raw.details as Record<string, unknown> | null;
  if (
    details === null ||
    typeof details !== "object" ||
    typeof raw.observedAt !== "string" ||
    !Number.isSafeInteger(raw.version) ||
    (raw.version as number) < 0 ||
    (raw.recordedAt !== null && typeof raw.recordedAt !== "string")
  )
    return fail("Unavailable");
  return Object.freeze({
    observedAt: raw.observedAt,
    canChange: flag(raw.canChange),
    version: raw.version as number,
    recordedAt: raw.recordedAt as string | null,
    details: Object.freeze({
      gstHstNumber: nullableText(details.gstHstNumber, 32),
      qstNumber: nullableText(details.qstNumber, 32),
      pstNumber: nullableText(details.pstNumber, 32),
      privacyNoticeUrl: nullableText(details.privacyNoticeUrl, 500),
    }),
    gaps: parseGaps(raw.gaps),
  });
}

export function createStoreReceiptProfileClient(options: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher ?? fetch;
  const request = async (init: RequestInit) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetcher("/merchant/store/receipt-profile", {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.freeze({
    async load(): Promise<StoreReceiptProfileView> {
      let response: Response;
      try {
        response = await request({ method: "GET", headers: { Accept: "application/json" } });
      } catch {
        return fail("Unavailable");
      }
      if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
      if (!response.ok) return fail("Unavailable");
      return parseStoreReceiptProfileView(await response.json().catch(() => null));
    },
    async save(body: StoreReceiptProfileSaveBody) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(options.csrf)) return fail("Invalid");
      let response: Response;
      try {
        response = await request({
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": options.csrf,
          },
          body: JSON.stringify(body),
        });
      } catch {
        return fail("OutcomeUnknown");
      }
      if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
      if (response.status === 422 || response.status === 400) return fail("Invalid");
      if (response.status === 409) {
        const error = (await response.json().catch(() => null)) as { error?: unknown } | null;
        return fail(error?.error === "no_change" ? "NoChange" : "Conflict");
      }
      if (response.status === 503) return fail("Unavailable");
      if (!response.ok) return fail("OutcomeUnknown");
      const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        raw === null ||
        typeof raw !== "object" ||
        !["Recorded", "AlreadyRecorded"].includes(String(raw.status)) ||
        !Number.isSafeInteger(raw.version)
      )
        return fail("OutcomeUnknown");
      return Object.freeze({ version: raw.version as number, gaps: parseGaps(raw.gaps) });
    },
  });
}
