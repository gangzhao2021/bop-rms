/**
 * WP-2423 DEC-STORE-CUSTOMER-NAME: the Store's name, address and phone as customers see them
 * (menu, order page, pickup panel and new receipts). The browser sends what the Owner typed and
 * the version they saw; Store, actor and time are decided by the server.
 */
export interface StorePublicProfileAddress {
  readonly addressLines: readonly string[];
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
  readonly countryCode: string;
}
export interface StorePublicProfileCurrent {
  readonly version: number;
  readonly publishedAt: string;
  readonly defaultLocale: string;
  readonly names: readonly { readonly locale: string; readonly storeDisplayName: string }[];
  readonly address: StorePublicProfileAddress;
  readonly businessPhone: string | null;
}
export interface StorePublicProfileView {
  readonly observedAt: string;
  readonly canChange: boolean;
  readonly locales: readonly string[];
  readonly current: StorePublicProfileCurrent | null;
  readonly regionCodes: readonly string[];
}
export interface StorePublicProfileSaveBody {
  readonly expectedVersion: number;
  readonly operationReference: string;
  readonly details: {
    readonly storeDisplayNames: Readonly<Record<string, string>>;
    readonly address: {
      readonly addressLines: readonly string[];
      readonly locality: string;
      readonly regionCode: string;
      readonly postalCode: string;
    };
    readonly businessPhone: string | null;
  };
}

export class StorePublicProfileClientError extends Error {
  constructor(
    readonly code:
      "PermissionDenied" | "Invalid" | "Conflict" | "NoChange" | "Unavailable" | "OutcomeUnknown",
  ) {
    super("Store name and contact details are unavailable");
    this.name = "StorePublicProfileClientError";
  }
}
const fail = (code: StorePublicProfileClientError["code"]): never => {
  throw new StorePublicProfileClientError(code);
};
const text = (value: unknown, maximum: number): string =>
  typeof value === "string" && value.length <= maximum ? value : fail("Unavailable");
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail("Unavailable");
const strings = (value: unknown, maximum: number, length: number): readonly string[] =>
  Array.isArray(value) && value.length <= length
    ? Object.freeze(value.map((item) => text(item, maximum)))
    : fail("Unavailable");

function parseCurrent(value: unknown): StorePublicProfileCurrent | null {
  if (value === null) return null;
  const raw = record(value);
  const address = record(raw.address);
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) return fail("Unavailable");
  if (!Array.isArray(raw.names) || raw.names.length < 1 || raw.names.length > 12)
    return fail("Unavailable");
  return Object.freeze({
    version: raw.version as number,
    publishedAt: text(raw.publishedAt, 40),
    defaultLocale: text(raw.defaultLocale, 20),
    names: Object.freeze(
      raw.names.map((entry) => {
        const name = record(entry);
        return Object.freeze({
          locale: text(name.locale, 20),
          storeDisplayName: text(name.storeDisplayName, 120),
        });
      }),
    ),
    address: Object.freeze({
      addressLines: strings(address.addressLines, 160, 3),
      locality: text(address.locality, 96),
      regionCode: text(address.regionCode, 16),
      postalCode: text(address.postalCode, 16),
      countryCode: text(address.countryCode, 2),
    }),
    businessPhone: raw.businessPhone === null ? null : text(raw.businessPhone, 16),
  });
}

export function parseStorePublicProfileView(value: unknown): StorePublicProfileView {
  const raw = record(value);
  if (typeof raw.canChange !== "boolean") return fail("Unavailable");
  const locales = strings(raw.locales, 20, 12);
  if (locales.length < 1) return fail("Unavailable");
  return Object.freeze({
    observedAt: text(raw.observedAt, 40),
    canChange: raw.canChange,
    locales,
    current: parseCurrent(raw.current),
    regionCodes: strings(raw.regionCodes, 16, 20),
  });
}

export function createStorePublicProfileClient(options: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher ?? fetch;
  const request = async (init: RequestInit) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetcher("/merchant/store/public-profile", {
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
    async load(): Promise<StorePublicProfileView> {
      let response: Response;
      try {
        response = await request({ method: "GET", headers: { Accept: "application/json" } });
      } catch {
        return fail("Unavailable");
      }
      if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
      if (!response.ok) return fail("Unavailable");
      return parseStorePublicProfileView(await response.json().catch(() => null));
    },
    async save(body: StorePublicProfileSaveBody) {
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
        !["Published", "AlreadyPublished"].includes(String(raw.status))
      )
        return fail("OutcomeUnknown");
      let current: StorePublicProfileCurrent | null;
      try {
        current = parseCurrent(raw.current);
      } catch {
        return fail("OutcomeUnknown");
      }
      if (current === null) return fail("OutcomeUnknown");
      return current;
    },
  });
}
