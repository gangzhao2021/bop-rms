import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useEffect, useState } from "react";
import { Link } from "react-router";

/** WP-2423 8.7: TAX-STORE-REVIEW — the Store's tax rates and every product's tax class, read only. */
export interface TaxReviewView {
  readonly screenId: "TAX-STORE-REVIEW";
  readonly sourceAsOf: string;
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
    super("Tax review is unavailable");
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
  Loading: "Loading tax review…",
  PermissionDenied: "You do not have permission to read this Store's tax configuration.",
  Offline: "Offline. Check your connection and refresh.",
  Unavailable: "Tax review is unavailable.",
} as const;
const endText = {
  Configuration: "the configuration ends",
  RegistrationEvidence: "its tax registration evidence expires",
  ProfessionalEvidence: "its professional review expires",
} as const;
const orderTypeText: Record<string, string> = { Pickup: "Pickup", DineIn: "Dine-in" };
const day = (instant: string) => instant.slice(0, 10);

export function StoreTaxReviewPage({
  client = unavailable,
}: {
  readonly client?: TaxReviewClient;
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
      <StatePanel heading="Tax review" tone={state.kind === "Loading" ? "neutral" : "error"} status>
        <p>{copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  const c = view.configuration;
  const classLabel = (reference: string | null) => {
    const index = view.classes.findIndex((item) => item.taxClassificationReference === reference);
    return index < 0 ? "Not taxed at this Store" : `Class ${index + 1}`;
  };
  const problems = view.products.filter((product) => product.status !== "Covered");
  return (
    <AppFrame title="Tax review" description="TAX-STORE-REVIEW">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">TAX-STORE-REVIEW · Store</p>
          <h2>Tax review</h2>
          <p>
            The tax this Store charges on each product for pickup and dine-in. Rates change only
            through the tax configuration, with registration and professional review evidence.
            Source as of <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        <Link to="/app/commerce/products">Products</Link>
      </header>
      {c === null ? (
        <StatePanel heading="No tax configuration in effect" tone="error" status>
          <p>
            This Store has no current tax configuration, so no order can be priced. A tax
            configuration with registration and professional review evidence is required.
          </p>
        </StatePanel>
      ) : (
        <>
          {c.testOnly ? (
            <StatePanel heading="Internal test rates" tone="error" status>
              <p>
                These rates are TEST-ONLY values for internal testing, not verified tax facts.
                Before real sales, the Store's registration and a professional review must confirm
                the rates (for example Ontario HST and any point-of-sale rebate on prepared food).
              </p>
            </StatePanel>
          ) : null}
          {c.endingSoon && c.endsAt !== null && c.endsBecause !== null ? (
            <StatePanel heading="Tax configuration ending soon" tone="error" status>
              <p>
                Orders can be priced until {day(c.endsAt)}, when {endText[c.endsBecause]}. Renew it
                before then or the Store cannot take orders.
              </p>
            </StatePanel>
          ) : null}
          <section className="detail-section" aria-labelledby="tax-configuration">
            <h3 id="tax-configuration">Configuration</h3>
            <dl>
              <dt>Configuration</dt>
              <dd>
                {c.stableCode} · version {c.versionNumber} · {c.jurisdictionCode} · {c.currencyCode}
              </dd>
              <dt>In effect</dt>
              <dd>
                from {day(c.effectiveFrom)}
                {c.effectiveUntil === null ? ", no end date" : ` until ${day(c.effectiveUntil)}`}
              </dd>
              <dt>Registration evidence valid until</dt>
              <dd>{day(c.registrationEvidenceValidUntil)}</dd>
              <dt>Professional review valid until</dt>
              <dd>{day(c.professionalEvidenceValidUntil)}</dd>
            </dl>
          </section>
        </>
      )}
      <section className="detail-section" aria-labelledby="tax-classes">
        <h3 id="tax-classes">Tax classes</h3>
        {view.classes.length === 0 ? (
          <p>No tax class is in effect.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Class</th>
                <th>Rates</th>
                <th>Products</th>
              </tr>
            </thead>
            <tbody>
              {view.classes.map((item, index) => (
                <tr key={item.taxClassificationReference}>
                  <td>Class {index + 1}</td>
                  <td data-label="Rates">
                    {item.rules
                      .map(
                        (rule) =>
                          `${orderTypeText[rule.orderType] ?? rule.orderType}: ${
                            rule.treatment === "Taxable" ? percent(rule.rate) : rule.treatment
                          }${rule.priceInclusion === "Inclusive" ? " (included in price)" : ""}`,
                      )
                      .join(" · ")}
                  </td>
                  <td data-label="Products">
                    {item.productNames.length === 0 ? "—" : item.productNames.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="detail-section" aria-labelledby="tax-products">
        <h3 id="tax-products">Products</h3>
        {problems.length > 0 ? (
          <StatePanel heading="Products that cannot be taxed" tone="error" status>
            <p>
              {problems.length} product{problems.length === 1 ? "" : "s"} cannot be priced for every
              order type. Menus offering them are not submitted for review until fixed on the
              product page.
            </p>
          </StatePanel>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Tax class</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {view.products.map((product) => (
              <tr key={product.productReference}>
                <td>
                  <Link to={`/app/commerce/products/${product.productReference}/edit`}>
                    {product.name}
                  </Link>
                  {product.selling ? "" : " (not selling yet)"}
                </td>
                <td data-label="Tax class">
                  {product.taxClassificationReference === null
                    ? "None"
                    : classLabel(product.taxClassificationReference)}
                </td>
                <td data-label="Status">
                  {product.status === "Covered"
                    ? "Taxed for pickup and dine-in"
                    : product.status === "NoTaxClass"
                      ? "No tax class"
                      : `No rate for ${product.missingOrderTypes
                          .map((type) => orderTypeText[type] ?? type)
                          .join(" and ")}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppFrame>
  );
}
