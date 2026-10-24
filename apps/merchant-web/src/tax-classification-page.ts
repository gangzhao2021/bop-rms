import { t } from "./i18n/i18n.js";
import { FULL_SIGN_IN_REQUIRED, isFullSignInRequired } from "./full-sign-in.js";

/**
 * WP-2423 Store setup in product: CAT-TAX-CLASSIFICATION-LIST client. The Brand's own tax
 * classification labels; the server keeps every change as an append-only version.
 */
export interface TaxClassificationView {
  readonly screenId: "CAT-TAX-CLASSIFICATION-LIST";
  readonly sourceAsOf: string;
  readonly permissions: { readonly mayManage: boolean };
  readonly registryVersion: number;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly classifications: readonly TaxClassificationEntry[];
  /**
   * The Brand's products by the tax class they name (null: none), including classes not listed
   * here (from the Store's tax configuration). Null when the viewer may not read products.
   */
  readonly productTaxClasses: readonly ProductTaxClassUse[] | null;
}
export interface ProductTaxClassUse {
  readonly classificationReference: string | null;
  readonly productNames: readonly string[];
}
export interface TaxClassificationEntry {
  readonly classificationReference: string;
  readonly names: Readonly<Record<string, string>>;
  readonly lifecycle: "Active" | "Inactive" | "Retired";
  readonly isDefault: boolean;
}
export type TaxClassificationCommand =
  | {
      readonly action: "Add";
      readonly operationReference: string;
      readonly expectedRegistryVersion: number;
      readonly classifications: readonly { readonly names: Readonly<Record<string, string>> }[];
    }
  | {
      readonly action: "Rename";
      readonly operationReference: string;
      readonly expectedRegistryVersion: number;
      readonly classificationReference: string;
      readonly names: Readonly<Record<string, string>>;
    }
  | {
      readonly action: "SetDefault";
      readonly operationReference: string;
      readonly expectedRegistryVersion: number;
      readonly classificationReference: string | null;
    }
  | {
      readonly action: "Retire";
      readonly operationReference: string;
      readonly expectedRegistryVersion: number;
      readonly classificationReference: string;
    };
export type TaxClassificationErrorCode =
  | "PermissionDenied"
  | "Invalid"
  | "NotFound"
  | "NameTaken"
  | "Retired"
  | "Conflict"
  | "Unavailable"
  | "Offline"
  | typeof FULL_SIGN_IN_REQUIRED;
export class TaxClassificationPageError extends Error {
  constructor(readonly code: TaxClassificationErrorCode) {
    super(t("Tax classifications could not be loaded or changed"));
    this.name = "TaxClassificationPageError";
  }
}
export interface TaxClassificationClient {
  load(): Promise<TaxClassificationView>;
  command(
    body: TaxClassificationCommand,
  ): Promise<{ readonly status: "Applied" | "Replayed"; readonly view: TaxClassificationView }>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  locale = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,120}$/u;
const invalid = (): never => {
  throw new TaxClassificationPageError("Unavailable");
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return invalid();
  return value as Record<string, unknown>;
}
export function parseTaxClassificationView(value: unknown): TaxClassificationView {
  const r = closed(value, [
    "screenId",
    "sourceAsOf",
    "permissions",
    "registryVersion",
    "defaultLocale",
    "locales",
    "classifications",
    "productTaxClasses",
  ]);
  const permissions = closed(r.permissions, ["mayManage"]);
  if (
    r.screenId !== "CAT-TAX-CLASSIFICATION-LIST" ||
    typeof r.sourceAsOf !== "string" ||
    !instant.test(r.sourceAsOf) ||
    typeof permissions.mayManage !== "boolean" ||
    !Number.isSafeInteger(r.registryVersion) ||
    (r.registryVersion as number) < 0 ||
    typeof r.defaultLocale !== "string" ||
    !locale.test(r.defaultLocale) ||
    !Array.isArray(r.locales) ||
    !r.locales.every((l) => typeof l === "string" && locale.test(l)) ||
    r.locales[0] !== r.defaultLocale ||
    !Array.isArray(r.classifications) ||
    (r.productTaxClasses !== null && !Array.isArray(r.productTaxClasses))
  )
    return invalid();
  const defaultLocale = r.defaultLocale;
  const classifications = r.classifications.map((item: unknown): TaxClassificationEntry => {
    const c = closed(item, ["classificationReference", "names", "lifecycle", "isDefault"]);
    const names = closed(c.names, Object.keys((c.names ?? {}) as object));
    if (
      typeof c.classificationReference !== "string" ||
      !uuid.test(c.classificationReference) ||
      !["Active", "Inactive", "Retired"].includes(String(c.lifecycle)) ||
      typeof c.isDefault !== "boolean" ||
      typeof names[defaultLocale] !== "string" ||
      !Object.entries(names).every(
        ([key, name]) => locale.test(key) && typeof name === "string" && safe.test(name),
      )
    )
      return invalid();
    return Object.freeze({
      classificationReference: c.classificationReference,
      names: Object.freeze({ ...(names as Record<string, string>) }),
      lifecycle: c.lifecycle as TaxClassificationEntry["lifecycle"],
      isDefault: c.isDefault,
    });
  });
  const productTaxClasses =
    r.productTaxClasses === null
      ? null
      : Object.freeze(
          (r.productTaxClasses as unknown[]).map((item): ProductTaxClassUse => {
            const u = closed(item, ["classificationReference", "productNames"]);
            if (
              (u.classificationReference !== null &&
                (typeof u.classificationReference !== "string" ||
                  !uuid.test(u.classificationReference))) ||
              !Array.isArray(u.productNames) ||
              !u.productNames.every((name) => typeof name === "string" && safe.test(name))
            )
              return invalid();
            return Object.freeze({
              classificationReference: u.classificationReference,
              productNames: Object.freeze([...(u.productNames as string[])]),
            });
          }),
        );
  return Object.freeze({
    screenId: "CAT-TAX-CLASSIFICATION-LIST",
    sourceAsOf: r.sourceAsOf,
    permissions: Object.freeze({ mayManage: permissions.mayManage }),
    registryVersion: r.registryVersion as number,
    defaultLocale,
    locales: Object.freeze([...(r.locales as string[])]),
    classifications: Object.freeze(classifications),
    productTaxClasses,
  });
}
const codes = new Set<string>([
  "PermissionDenied",
  "Invalid",
  "NotFound",
  "NameTaken",
  "Retired",
  "Conflict",
  "Unavailable",
]);
export function createTaxClassificationClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): TaxClassificationClient {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TaxClassificationPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (isFullSignInRequired(response.status, payload))
        throw new TaxClassificationPageError(FULL_SIGN_IN_REQUIRED);
      const code = String(payload?.error);
      throw new TaxClassificationPageError(
        codes.has(code)
          ? (code as TaxClassificationErrorCode)
          : response.status === 403
            ? "PermissionDenied"
            : "Unavailable",
      );
    }
    return (await response.json().catch(() => invalid())) as unknown;
  };
  return {
    load: async () =>
      parseTaxClassificationView(await post("/merchant/commerce/tax-classifications/query", {})),
    command: async (body) => {
      const r = closed(await post("/merchant/commerce/tax-classifications/command", body), [
        "status",
        "view",
      ]);
      if (r.status !== "Applied" && r.status !== "Replayed") return invalid();
      return { status: r.status, view: parseTaxClassificationView(r.view) };
    },
  };
}

/** Plain words for every refusal (never a code). */
export const taxClassificationMessages: Readonly<Record<TaxClassificationErrorCode, string>> =
  Object.freeze({
    PermissionDenied: t("Only the Brand Owner can add or change tax classifications."),
    Invalid:
      "Check the names: each needs up to 120 characters and cannot contain links or the characters < > { } [ ].",
    NotFound: t("That classification is no longer in the list. Reload to see the current list."),
    NameTaken: t("Another classification in use already has that name. Choose a different name."),
    Retired: t(
      "That classification is retired. It can't be renamed, made the default or used again.",
    ),
    Conflict: t("Someone else changed the list. Reload to see the latest list, then try again."),
    Unavailable: t("Tax classifications can't be reached right now. Try again in a moment."),
    Offline: t("You're offline. Check the connection and try again; nothing was changed."),
    FullSignInRequired: t("Confirm it's you before changing tax classifications."),
  });
/** The label of a name field: the Brand's default language is required, the other optional. */
export function nameFieldLabel(fieldLocale: string, defaultLocale: string): string {
  const language =
    fieldLocale === "fr-CA"
      ? t("French")
      : fieldLocale === "en-CA"
        ? t("English")
        : t("Other language");
  return fieldLocale === defaultLocale
    ? t("{language} name", { language: language })
    : t("{language} name (optional)", { language: language });
}
