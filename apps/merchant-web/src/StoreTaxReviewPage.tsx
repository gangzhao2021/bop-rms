import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime, StoreDate } from "./StoreTime.js";
import { useEffect, useState } from "react";
import { Link } from "react-router";

/** WP-2423 8.7: TAX-STORE-REVIEW — the Store's tax rates and every product's tax class, read only. */
export interface TaxReviewView {
  readonly screenId: "TAX-STORE-REVIEW";
  readonly sourceAsOf: string;
  /** WP-2423 Q15/Q16: what customer receipts and checkout still lack (absent from older APIs). */
  readonly receiptSetup?: {
    readonly taxRegistrationMissing: boolean;
    readonly privacyNoticeMissing: boolean;
  };
  readonly configuration: {
    readonly stableCode: string;
    readonly versionNumber: number;
    readonly jurisdictionCode: string;
    readonly currencyCode: string;
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
    readonly registrationEvidenceValidUntil: string;
    readonly professionalEvidenceValidUntil: string;
    readonly testOnly: boolean;
    readonly endsAt: string | null;
    readonly endsBecause: "Configuration" | "RegistrationEvidence" | "ProfessionalEvidence" | null;
    readonly endingSoon: boolean;
  } | null;
  readonly classes: readonly {
    readonly taxClassificationReference: string;
    readonly rules: readonly {
      readonly orderType: string;
      readonly taxComponentCode: string;
      readonly treatment: string;
      readonly rate: string;
      readonly priceInclusion: string;
    }[];
    readonly productNames: readonly string[];
  }[];
  readonly products: readonly {
    readonly productReference: string;
    readonly name: string;
    readonly selling: boolean;
    readonly taxClassificationReference: string | null;
    readonly status: "Covered" | "NoTaxClass" | "NotCovered";
    readonly missingOrderTypes: readonly string[];
  }[];
}
export interface TaxReviewClient {
  load(): Promise<unknown>;
}
export class TaxReviewPageError extends Error {
  constructor(readonly code: "PermissionDenied" | "Offline" | "Unavailable") {
    super(t("Tax review is unavailable"));
    this.name = "TaxReviewPageError";
  }
}
export function parseTaxReviewView(value: unknown): TaxReviewView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "TAX-STORE-REVIEW" ||
    !Array.isArray(r.classes) ||
    !Array.isArray(r.products)
  )
    throw new Error("TAX_REVIEW_PAGE_INVALID");
  return r as unknown as TaxReviewView;
}
export function createTaxReviewClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): TaxReviewClient {
  return {
    load: async () => {
      let response: Response;
      try {
        response = await fetcher("/merchant/commerce/tax-review/query", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-bop-csrf": csrf },
          body: "{}",
        });
      } catch {
        throw new TaxReviewPageError("Offline");
      }
      if (!response.ok)
        throw new TaxReviewPageError(response.status === 403 ? "PermissionDenied" : "Unavailable");
      return response.json() as Promise<unknown>;
    },
  };
}
const unavailable: TaxReviewClient = {
  load: async () => {
    throw new TaxReviewPageError("Unavailable");
  },
};
/** "13%" from "0.13"; "5.5%" from "0.055". */
export function percent(rate: string): string {
  const [whole = "0", fraction = ""] = rate.split(".");
  const scaled = (whole + fraction.padEnd(2, "0").slice(0, 2)).replace(/^0+(?=\d)/u, "");
  const rest = fraction.slice(2).replace(/0+$/u, "");
  return scaled + (rest ? "." + rest : "") + "%";
}
const copy = {
  Loading: t("Loading tax review…"),
  PermissionDenied: t("You do not have permission to read this Store's tax configuration."),
  Offline: t("Offline. Check your connection and refresh."),
  Unavailable: t("Tax review is unavailable."),
} as const;
const endText = {
  Configuration: t("the configuration ends"),
  RegistrationEvidence: t("its tax registration evidence expires"),
  ProfessionalEvidence: t("its professional review expires"),
} as const;
const orderTypeText: Record<string, string> = { Pickup: t("Pickup"), DineIn: t("Dine-in") };
const treatmentText: Record<string, string> = {
  ZeroRated: "zero-rated",
  Exempt: "tax-exempt",
  OutOfScope: t("not taxed"),
};
const provinceText: Readonly<Record<string, string>> = {
  "CA-AB": t("Alberta"),
  "CA-BC": t("British Columbia"),
  "CA-MB": t("Manitoba"),
  "CA-NB": t("New Brunswick"),
  "CA-NL": t("Newfoundland and Labrador"),
  "CA-NS": t("Nova Scotia"),
  "CA-NT": t("Northwest Territories"),
  "CA-NU": t("Nunavut"),
  "CA-ON": t("Ontario"),
  "CA-PE": t("Prince Edward Island"),
  "CA-QC": t("Quebec"),
  "CA-SK": t("Saskatchewan"),
  "CA-YT": t("Yukon"),
};
const currencyText: Readonly<Record<string, string>> = { CAD: t("Canadian dollars") };

/**
 * WP-2423 Q15/Q16: tells staff, where they review tax, that customer receipts print no GST/HST
 * registration number or that checkout links no privacy notice, and where the Owner enters them.
 */
export function ReceiptSetupNotice({
  gaps,
  storeSetupHref,
}: {
  readonly gaps:
    | { readonly taxRegistrationMissing: boolean; readonly privacyNoticeMissing: boolean }
    | undefined;
  /** Omitted on the Store setup page itself, where the form is right below. */
  readonly storeSetupHref?: string;
}) {
  if (gaps === undefined || (!gaps.taxRegistrationMissing && !gaps.privacyNoticeMissing))
    return null;
  return (
    <StatePanel heading={t("Receipts and privacy need the Owner's details")} tone="error" status>
      <ul>
        {gaps.taxRegistrationMissing ? (
          <li>
            {t(
              "Customer receipts show no GST/HST registration number. If the business is registered for GST/HST (or QST/PST), the Owner adds the number so receipts can be used as tax receipts.",
            )}
          </li>
        ) : null}
        {gaps.privacyNoticeMissing ? (
          <li>
            {t("Add your privacy notice link before going live. Checkout and receipts show none.")}
          </li>
        ) : null}
      </ul>
      {storeSetupHref ? (
        <p>
          <Link to={storeSetupHref}>{t("Enter them in Store setup → Receipts and privacy")}</Link>
        </p>
      ) : null}
    </StatePanel>
  );
}

export function StoreTaxReviewPage({
  client = unavailable,
  storeSetupHref,
}: {
  readonly client?: TaxReviewClient;
  /** Where the Owner enters receipt registrations and the privacy notice link. */
  readonly storeSetupHref?: string;
}) {
  const [state, setState] = useState<
    { readonly kind: keyof typeof copy } | { readonly kind: "Found"; readonly view: TaxReviewView }
  >({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseTaxReviewView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof TaxReviewPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client]);
  if (state.kind !== "Found")
    return (
      <StatePanel
        heading={state.kind === "PermissionDenied" ? noAccessHeading : t("Tax review")}
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{state.kind === "PermissionDenied" ? pageAccessDeniedText : copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  const c = view.configuration;
  const classLabel = (reference: string | null) => {
    const index = view.classes.findIndex((item) => item.taxClassificationReference === reference);
    return index < 0 ? t("Not taxed at this Store") : t("Tax class {value}", { value: index + 1 });
  };
  const problems = view.products.filter((product) => product.status !== "Covered");
  return (
    <AppFrame title={t("Tax review")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Tax review · Store")}</p>
          <h2>{t("Tax review")}</h2>
          <p>
            {t(
              "The tax this Store charges on each product for pickup and dine-in. Rates change only through the tax configuration, with registration and professional review evidence. Source as of",
            )}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        <Link to="/app/commerce/products">{t("Products")}</Link>
      </header>
      <ReceiptSetupNotice
        gaps={view.receiptSetup}
        {...(storeSetupHref === undefined ? {} : { storeSetupHref })}
      />
      {c === null ? (
        <StatePanel heading={t("No tax configuration in effect")} tone="error" status>
          <p>
            {t(
              "This Store has no current tax configuration, so no order can be priced. A tax configuration with registration and professional review evidence is required.",
            )}
          </p>
        </StatePanel>
      ) : (
        <>
          {c.testOnly ? (
            <StatePanel heading={t("Internal test rates")} tone="error" status>
              <p>
                {t(
                  "These rates are test values for internal testing only, not verified tax facts. Before real sales, the Store's registration and a professional review must confirm the rates (for example Ontario HST and any point-of-sale rebate on prepared food).",
                )}
              </p>
            </StatePanel>
          ) : null}
          {c.endingSoon && c.endsAt !== null && c.endsBecause !== null ? (
            <StatePanel heading={t("Tax configuration ending soon")} tone="error" status>
              <p>
                {t("Orders can be priced until")} <StoreDate value={c.endsAt} />
                {t(", when {value}. Renew it before then or the Store cannot take orders.", {
                  value: endText[c.endsBecause],
                })}
              </p>
            </StatePanel>
          ) : null}
          <section className="detail-section" aria-labelledby="tax-configuration">
            <h3 id="tax-configuration">{t("Configuration")}</h3>
            <dl>
              <dt>{t("Configuration")}</dt>
              <dd>
                {t("{value} · version {versionNumber} · {value2} · prices in {value3}", {
                  value: c.testOnly
                    ? t("Test configuration (internal testing only)")
                    : t("Tax configuration"),
                  versionNumber: c.versionNumber,
                  value2: provinceText[c.jurisdictionCode] ?? c.jurisdictionCode,
                  value3: currencyText[c.currencyCode] ?? c.currencyCode,
                })}
              </dd>
              <dt>{t("In effect")}</dt>
              <dd>
                {t("from")} <StoreDate value={c.effectiveFrom} />
                {c.effectiveUntil === null ? (
                  t(", no end date")
                ) : (
                  <>
                    {" "}
                    {t("until")} <StoreDate value={c.effectiveUntil} />
                  </>
                )}
              </dd>
              <dt>{t("Registration evidence valid until")}</dt>
              <dd>
                <StoreDate value={c.registrationEvidenceValidUntil} />
              </dd>
              <dt>{t("Professional review valid until")}</dt>
              <dd>
                <StoreDate value={c.professionalEvidenceValidUntil} />
              </dd>
            </dl>
          </section>
        </>
      )}
      <section className="detail-section" aria-labelledby="tax-classes">
        <h3 id="tax-classes">{t("Tax classes")}</h3>
        {view.classes.length === 0 ? (
          <p>{t("No tax class is in effect.")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("Class")}</th>
                <th>{t("Rates")}</th>
                <th>{t("Products")}</th>
              </tr>
            </thead>
            <tbody>
              {view.classes.map((item, index) => (
                <tr key={item.taxClassificationReference}>
                  <td>{t("Tax class {value}", { value: index + 1 })}</td>
                  <td data-label={t("Rates")}>
                    {item.rules
                      .map(
                        (rule) =>
                          `${orderTypeText[rule.orderType] ?? rule.orderType}: ${
                            rule.treatment === "Taxable"
                              ? percent(rule.rate)
                              : (treatmentText[rule.treatment] ?? rule.treatment.toLowerCase())
                          }${rule.priceInclusion === "Inclusive" ? t(" (included in price)") : ""}`,
                      )
                      .join(" · ")}
                  </td>
                  <td data-label={t("Products")}>
                    {item.productNames.length === 0 ? "—" : item.productNames.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="detail-section" aria-labelledby="tax-products">
        <h3 id="tax-products">{t("Products")}</h3>
        {problems.length > 0 ? (
          <StatePanel heading={t("Products that cannot be taxed")} tone="error" status>
            <p>
              {t(
                "{length} product{value} cannot be priced for every order type. Menus offering them are not submitted for review until fixed on the product page.",
                { length: problems.length, value: problems.length === 1 ? "" : "s" },
              )}
            </p>
          </StatePanel>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>{t("Product")}</th>
              <th>{t("Tax class")}</th>
              <th>{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {view.products.map((product) => (
              <tr key={product.productReference}>
                <td>
                  <Link to={`/app/commerce/products/${product.productReference}/edit`}>
                    {product.name}
                  </Link>
                  {product.selling ? "" : t(" (not selling yet)")}
                </td>
                <td data-label={t("Tax class")}>
                  {product.taxClassificationReference === null
                    ? t("None")
                    : classLabel(product.taxClassificationReference)}
                </td>
                <td data-label={t("Status")}>
                  {product.status === "Covered"
                    ? t("Taxed for pickup and dine-in")
                    : product.status === "NoTaxClass"
                      ? t("No tax class")
                      : t("No rate for {value}", {
                          value: product.missingOrderTypes
                            .map((type) => orderTypeText[type] ?? type)
                            .join(" and "),
                        })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppFrame>
  );
}
