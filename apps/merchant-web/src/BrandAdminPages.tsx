import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  BrandAdminPageError,
  parseBrandAdminView,
  unavailableBrandAdminPageClient,
  type BrandAdminPageClient,
  type BrandAdminPageErrorCode,
  type BrandAdminView,
} from "./brand-admin-pages.js";
type State =
  | { readonly kind: "Loading" | BrandAdminPageErrorCode }
  | { readonly kind: "Found"; readonly view: BrandAdminView };
const label = (v: string) => v.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").replaceAll("_", " ");
export function BrandAdminState({
  state,
}: {
  readonly state: "Loading" | BrandAdminPageErrorCode;
}) {
  const copy = {
    Loading: "Loading authorized Brand metadata…",
    PermissionDenied: "Owner or Brand Admin permission is required.",
    NotFound: "No authorized Brand was found.",
    FeatureDisabled: "Brand administration is not enabled.",
    Stale: "Brand projection is stale. Refresh before acting.",
    Conflict: "Brand configuration or membership changed. Refresh before acting.",
    CommandFailed: "No Brand, publication or membership outcome was inferred.",
    Offline: "Offline read-only. Brand actions are disabled.",
    Unavailable: "Brand metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={state === "Loading" ? "Loading Brands" : "Brands unavailable"}
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
export function Brands({ view }: { readonly view: BrandAdminView }) {
  const actionable = view.freshness === "Fresh" && view.completeness === "Complete";
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId} · Organization</p>
          <h1>Brands</h1>
          <p>
            Source {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayCreate ? (
          <button disabled={!actionable}>Create Brand draft</button>
        ) : null}
      </header>
      <form className="list-filters" aria-label="Brand filters">
        <label>
          Name / code
          <input value={view.filters.nameOrCode ?? "All"} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.status ?? "All"} readOnly />
        </label>
        <label>
          Country / locale
          <input
            value={`${view.filters.countryCode ?? "All"} · ${view.filters.locale ?? "All"}`}
            readOnly
          />
        </label>
      </form>
      {view.brands.length === 0 ? (
        <StatePanel heading="No Brands" tone="neutral" status>
          <p>No authorized Brand metadata matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Brands">
          {view.brands.map((b) => (
            <article className="summary-card" key={b.brandReference}>
              <p className="bop-eyebrow">
                {b.code} · {b.lifecycle} · config v{b.configurationVersion}
              </p>
              <h2>{b.displayName}</h2>
              <p>
                Locales {b.supportedLocales.join(", ")} · default {b.defaultLocale} · {b.storeCount}{" "}
                Stores
              </p>
              <p>
                Catalog source {b.catalogSourceReference} · Theme {b.mediaThemeReference ?? "None"}
              </p>
              <p>
                Configuration {b.configurationStatus} · {b.effectiveFrom} →{" "}
                {b.effectiveUntil ?? "Open"}
              </p>
              <p>
                Membership{" "}
                {b.storeMemberships.map((m) => `${m.storeCode} ${m.action}`).join(", ") || "None"}
              </p>
              <p>
                Inheritance{" "}
                {b.inheritance
                  .map((i) => `${label(i.fieldCode)} = ${i.valueReference} from ${i.source}`)
                  .join(", ") || "None"}
              </p>
              <p>
                History {b.historyReferences.length} · Audit {b.auditSummaryReference}
              </p>
              <div className="card-actions">
                {view.permissions.mayEdit && b.lifecycle === "Draft" ? (
                  <button disabled={!actionable}>Edit Brand draft</button>
                ) : null}
                {view.permissions.mayActivate && b.lifecycle === "Draft" ? (
                  <button disabled={!actionable}>Activate Brand</button>
                ) : null}
                {view.permissions.mayPublish &&
                ["Draft", "PendingApproval", "Approved"].includes(b.configurationStatus) ? (
                  <button disabled={!actionable}>Publish configuration through approval</button>
                ) : null}
                {view.permissions.mayManageStoreMembership ? (
                  <button disabled={!actionable || b.lifecycle === "Archived"}>
                    Manage Store membership
                  </button>
                ) : null}
                {view.permissions.mayArchive && b.lifecycle !== "Archived" ? (
                  <button disabled={!actionable}>Archive Brand</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Inheritance always shows value reference, source and effective period. Store overrides
        cannot weaken Platform hard requirements or move a Store across Brands.
      </p>
    </main>
  );
}
export function BrandAdminPage({
  client = unavailableBrandAdminPageClient,
}: {
  readonly client?: BrandAdminPageClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (v) => {
        if (active) setState({ kind: "Found", view: parseBrandAdminView(v) });
      },
      (e: unknown) => {
        if (active) setState({ kind: e instanceof BrandAdminPageError ? e.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <Brands view={state.view} />
  ) : (
    <BrandAdminState state={state.kind} />
  );
}
export const BrandListPage = BrandAdminPage,
  BrandDetailPage = BrandAdminPage;
