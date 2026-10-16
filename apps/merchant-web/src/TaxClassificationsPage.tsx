import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { newOperationReference } from "./RoleAdministrationPages.js";
import { SourceTime } from "./StoreTime.js";
import { FULL_SIGN_IN_REQUIRED } from "./full-sign-in.js";
import {
  TaxClassificationPageError,
  nameFieldLabel,
  taxClassificationMessages,
  type TaxClassificationClient,
  type TaxClassificationCommand,
  type TaxClassificationEntry,
  type TaxClassificationErrorCode,
  type TaxClassificationView,
} from "./tax-classification-page.js";

/**
 * WP-2423 Store setup in product: CAT-TAX-CLASSIFICATION-LIST. The Brand Owner names the Brand's
 * tax classifications (its own labels), renames them, chooses the Brand default and retires ones no
 * longer used. Rates are not set here. Readers without the manage permission see the list only.
 */
const unavailable: TaxClassificationClient = {
  load: async () => {
    throw new TaxClassificationPageError("Unavailable");
  },
  command: async () => {
    throw new TaxClassificationPageError("Unavailable");
  },
};
type Draft = Readonly<Record<string, string>>;
const displayName = (entry: TaxClassificationEntry, defaultLocale: string) =>
  entry.names[defaultLocale] ?? Object.values(entry.names)[0] ?? "";
/** The names a draft submits: blank optional names are left out. */
function draftNames(draft: Draft, locales: readonly string[]) {
  const names: Record<string, string> = {};
  for (const l of locales) {
    const value = (draft[l] ?? "").trim();
    if (value) names[l] = value;
  }
  return names;
}
type Change =
  | { readonly action: "Add"; readonly names: Draft }
  | { readonly action: "Rename"; readonly classificationReference: string; readonly names: Draft }
  | { readonly action: "SetDefault"; readonly classificationReference: string | null }
  | { readonly action: "Retire"; readonly classificationReference: string };

export function TaxClassificationsView({
  view,
  busy,
  notice,
  error,
  csrf,
  onChange,
  onReload,
}: {
  readonly view: TaxClassificationView;
  readonly busy: boolean;
  readonly notice: string;
  readonly error: TaxClassificationErrorCode | null;
  readonly csrf: string;
  readonly onChange: (change: Change) => void;
  readonly onReload: () => void;
}) {
  const { defaultLocale, locales } = view;
  const manage = view.permissions.mayManage;
  const [adding, setAdding] = useState<Draft>({});
  const [renaming, setRenaming] = useState<{ reference: string; names: Draft } | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);
  // The typed names stay until the change is recorded (a refusal keeps them to correct).
  useEffect(() => setAdding({}), [view.registryVersion]);
  const inUse = view.classifications.filter((c) => c.lifecycle !== "Retired");
  const retired = view.classifications.filter((c) => c.lifecycle === "Retired");
  const nameFields = (
    draft: Draft,
    set: (next: Draft) => void,
    idPrefix: string,
    labelSuffix = "",
  ) =>
    locales.map((l) => (
      <label key={l} htmlFor={`${idPrefix}-${l}`}>
        {nameFieldLabel(l, defaultLocale)}
        {labelSuffix}
        <input
          id={`${idPrefix}-${l}`}
          value={draft[l] ?? ""}
          maxLength={120}
          required={l === defaultLocale}
          disabled={busy}
          onChange={(e) => set({ ...draft, [l]: e.currentTarget.value })}
        />
      </label>
    ));
  const retiringEntry = view.classifications.find((c) => c.classificationReference === retiring);
  return (
    <AppFrame title="Tax classifications" description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Tax classifications · Brand</p>
          <h2>Tax classifications</h2>
          <p>
            Your Brand&rsquo;s own labels for how things are taxed, such as Prepared food, Alcohol
            or Fees. Each product, and each Store fee (service charge, delivery fee and tips), names
            one. No rates are set here: the tax configuration sets the rates for each
            classification, and Tax review shows them. Updated{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        <Link to="/app/commerce/tax-review">Tax review</Link>
      </header>
      {!manage ? (
        <StatePanel heading="View only" status>
          <p>{taxClassificationMessages.PermissionDenied}</p>
        </StatePanel>
      ) : null}
      {error === FULL_SIGN_IN_REQUIRED ? (
        <FullSignInPrompt csrf={csrf} />
      ) : error !== null ? (
        <StatePanel heading="Not saved" tone="error" status>
          <p>{taxClassificationMessages[error]}</p>
          {error === "Conflict" || error === "NotFound" ? (
            <button type="button" onClick={onReload} disabled={busy}>
              Reload the list
            </button>
          ) : null}
        </StatePanel>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <section className="detail-section" aria-labelledby="tax-classifications-in-use">
        <h3 id="tax-classifications-in-use">In use</h3>
        {inUse.length === 0 ? (
          <p>
            No tax classifications yet.
            {manage
              ? " Add the first one below. Store setup fees can then be turned on with it."
              : " The Brand Owner adds them."}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                {locales.map((l) => (
                  <th key={l} scope="col">
                    {nameFieldLabel(l, l).replace(" name", "")}
                  </th>
                ))}
                <th scope="col">Brand default</th>
                {manage ? <th scope="col">Changes</th> : null}
              </tr>
            </thead>
            <tbody>
              {inUse.map((entry) => {
                const name = displayName(entry, defaultLocale);
                const editing = renaming?.reference === entry.classificationReference;
                return (
                  <tr key={entry.classificationReference}>
                    {locales.map((l) => (
                      <td key={l} data-label={nameFieldLabel(l, l).replace(" name", "")}>
                        {entry.names[l] ?? "—"}
                      </td>
                    ))}
                    <td data-label="Brand default">
                      {entry.isDefault ? "Default for products without their own" : "—"}
                    </td>
                    {manage ? (
                      <td data-label="Changes">
                        {editing && renaming ? (
                          <form
                            aria-label={`Rename ${name}`}
                            onSubmit={(e) => {
                              e.preventDefault();
                              onChange({
                                action: "Rename",
                                classificationReference: entry.classificationReference,
                                names: renaming.names,
                              });
                              setRenaming(null);
                            }}
                          >
                            {nameFields(
                              renaming.names,
                              (names) => setRenaming({ ...renaming, names }),
                              `rename-${entry.classificationReference}`,
                            )}
                            <div className="card-actions">
                              <button
                                type="submit"
                                disabled={busy || !(renaming.names[defaultLocale] ?? "").trim()}
                              >
                                Save name
                              </button>
                              <button type="button" onClick={() => setRenaming(null)}>
                                Cancel
                              </button>
                            </div>
                          </form>
                        ) : (
                          <div className="card-actions">
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`Rename ${name}`}
                              onClick={() =>
                                setRenaming({
                                  reference: entry.classificationReference,
                                  names: entry.names,
                                })
                              }
                            >
                              Rename
                            </button>
                            {entry.lifecycle === "Active" ? (
                              <button
                                type="button"
                                disabled={busy}
                                aria-label={
                                  entry.isDefault
                                    ? `Stop using ${name} as the default`
                                    : `Make ${name} the default`
                                }
                                onClick={() =>
                                  onChange({
                                    action: "SetDefault",
                                    classificationReference: entry.isDefault
                                      ? null
                                      : entry.classificationReference,
                                  })
                                }
                              >
                                {entry.isDefault ? "Stop using as default" : "Make default"}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`Retire ${name}`}
                              onClick={() => setRetiring(entry.classificationReference)}
                            >
                              Retire
                            </button>
                          </div>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {manage && retiringEntry ? (
          <section
            className="detail-section"
            role="alertdialog"
            aria-labelledby="retire-classification-heading"
            aria-describedby="retire-classification-text"
          >
            <h4 id="retire-classification-heading">
              Retire {displayName(retiringEntry, defaultLocale)} for good?
            </h4>
            <p id="retire-classification-text">
              A retired classification can&rsquo;t be used again or brought back. Products and Store
              fees that use it must be moved to another classification before they are next
              published; menus and Store settings already published keep working.
              {retiringEntry.isDefault
                ? " It is the Brand default now, so the Brand will have no default until you choose another."
                : ""}
            </p>
            <div className="card-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onChange({
                    action: "Retire",
                    classificationReference: retiringEntry.classificationReference,
                  });
                  setRetiring(null);
                }}
              >
                Retire for good
              </button>
              <button type="button" onClick={() => setRetiring(null)}>
                Keep it
              </button>
            </div>
          </section>
        ) : null}
      </section>
      {manage ? (
        <section className="detail-section" aria-labelledby="tax-classification-add">
          <h3 id="tax-classification-add">Add a classification</h3>
          <form
            aria-labelledby="tax-classification-add"
            onSubmit={(e) => {
              e.preventDefault();
              onChange({ action: "Add", names: adding });
            }}
          >
            {nameFields(adding, setAdding, "add-classification")}
            <p className="field-hint">
              Use a name staff will recognise. You can rename it later; products and fees keep using
              it.
            </p>
            <button type="submit" disabled={busy || !(adding[defaultLocale] ?? "").trim()}>
              Add classification
            </button>
          </form>
        </section>
      ) : null}
      {retired.length > 0 ? (
        <section className="detail-section" aria-labelledby="tax-classifications-retired">
          <h3 id="tax-classifications-retired">Retired</h3>
          <p>
            Kept for the history of products and fees that used them; they can&rsquo;t be chosen.
          </p>
          <ul>
            {retired.map((entry) => (
              <li key={entry.classificationReference}>{displayName(entry, defaultLocale)}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppFrame>
  );
}

const loadCopy = {
  Loading: "Loading tax classifications…",
  ...taxClassificationMessages,
} as const;

export function TaxClassificationsPage({
  client = unavailable,
  csrf = "",
}: {
  readonly client?: TaxClassificationClient;
  readonly csrf?: string;
}) {
  const [view, setView] = useState<TaxClassificationView | null>(null);
  const [loadError, setLoadError] = useState<keyof typeof loadCopy>("Loading");
  const [error, setError] = useState<TaxClassificationErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // One operation reference per intended change, kept until it succeeds, so a retry after a lost
  // answer is recognised by the server instead of applied twice.
  const pending = useRef<{ key: string; reference: string } | null>(null);
  const load = useCallback(() => {
    let active = true;
    setLoadError("Loading");
    void client
      .load()
      .then((value) => {
        if (!active) return;
        setView(value);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setView(null);
        setLoadError(reason instanceof TaxClassificationPageError ? reason.code : "Unavailable");
      });
    return () => {
      active = false;
    };
  }, [client]);
  useEffect(() => load(), [load]);
  if (view === null)
    return (
      <StatePanel
        heading="Tax classifications"
        tone={loadError === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{loadCopy[loadError]}</p>
      </StatePanel>
    );
  const submit = (change: Change) => {
    const key = JSON.stringify([view.registryVersion, change]);
    if (pending.current?.key !== key) pending.current = { key, reference: newOperationReference() };
    const operationReference = pending.current.reference,
      expectedRegistryVersion = view.registryVersion;
    let body: TaxClassificationCommand;
    switch (change.action) {
      case "Add":
        body = {
          action: "Add",
          operationReference,
          expectedRegistryVersion,
          classifications: [{ names: draftNames(change.names, view.locales) }],
        };
        break;
      case "Rename":
        body = {
          action: "Rename",
          operationReference,
          expectedRegistryVersion,
          classificationReference: change.classificationReference,
          names: draftNames(change.names, view.locales),
        };
        break;
      default:
        body = { ...change, operationReference, expectedRegistryVersion };
    }
    const label =
      change.action === "Add" || change.action === "Rename"
        ? (draftNames(change.names, view.locales)[view.defaultLocale] ?? "")
        : (view.classifications.find(
            (c) => c.classificationReference === change.classificationReference,
          )?.names[view.defaultLocale] ?? "");
    setBusy(true);
    setNotice("");
    setError(null);
    void client
      .command(body)
      .then((result) => {
        pending.current = null;
        setView(result.view);
        setNotice(
          change.action === "Add"
            ? `Added ${label}.`
            : change.action === "Rename"
              ? `Renamed to ${label}.`
              : change.action === "Retire"
                ? `Retired ${label}.`
                : change.classificationReference === null
                  ? "The Brand has no default classification now."
                  : `${label} is now the Brand default.`,
        );
      })
      .catch((reason: unknown) =>
        setError(reason instanceof TaxClassificationPageError ? reason.code : "Unavailable"),
      )
      .finally(() => setBusy(false));
  };
  return (
    <TaxClassificationsView
      view={view}
      busy={busy}
      notice={notice}
      error={error}
      csrf={csrf}
      onChange={submit}
      onReload={() => {
        pending.current = null;
        setNotice("");
        load();
      }}
    />
  );
}
