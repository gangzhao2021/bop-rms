import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import { WorkspacePage } from "./WorkspacePage.js";
import {
  openStore,
  StoreOpeningClientError,
  storeOpeningLocales,
  storeOpeningTimeZones,
} from "./store-opening-client.js";

/** City names staff recognise, not IANA codes. */
const timeZoneText: Record<(typeof storeOpeningTimeZones)[number], string> = {
  "America/Toronto": t("Eastern time (Toronto, Ottawa, Montréal)"),
  "America/Vancouver": t("Pacific time (Vancouver)"),
  "America/Edmonton": t("Mountain time (Calgary, Edmonton)"),
  "America/Winnipeg": t("Central time (Winnipeg)"),
  "America/Regina": t("Saskatchewan (Regina, Saskatoon)"),
  "America/Halifax": t("Atlantic time (Halifax)"),
  "America/St_Johns": t("Newfoundland time (St. John's)"),
  "America/Moncton": t("Atlantic time (Moncton)"),
  "America/Whitehorse": t("Yukon (Whitehorse)"),
};
const localeText: Record<(typeof storeOpeningLocales)[number], string> = {
  "en-CA": t("English"),
  "fr-CA": t("French"),
};

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (Section 88 ORG-STORE-LIST): the Brand's Stores
 * this person works in, switching between them, and — for the Brand's Owner — opening another one.
 * The server decides who may open a Store; the page only explains a refusal.
 */
export function StoresPage({
  stores,
  currentStoreReference,
  csrf,
  switching,
  mayOpen,
  onSwitchStore,
  fetcher,
}: {
  readonly stores: readonly { readonly storeReference: string; readonly storeLabel: string }[];
  readonly currentStoreReference: string;
  readonly csrf: string;
  readonly switching: boolean;
  /** The Owner of this Store (its setup is theirs); the server still decides. */
  readonly mayOpen: boolean;
  readonly onSwitchStore: (storeReference: string) => void;
  readonly fetcher?: typeof fetch;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [timeZone, setTimeZone] = useState<string>(storeOpeningTimeZones[0]);
  const [locale, setLocale] = useState<string>(storeOpeningLocales[0]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const operation = useRef<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    operation.current ??= newOperationReference();
    try {
      await openStore(
        csrf,
        {
          operationReference: operation.current,
          code: code.trim().toUpperCase(),
          displayName: name.trim(),
          timeZone,
          locale,
        },
        fetcher,
      );
      operation.current = null;
      setMessage({
        tone: "status",
        text: t(
          "{name} is opened. Before staff can work there, its roles, setup and go-live check are installed; it then appears in this list. Guests can't order there until it is live.",
          { name: name.trim() },
        ),
      });
      setName("");
      setCode("");
    } catch (error) {
      const failure = error instanceof StoreOpeningClientError ? error.code : "Unavailable";
      // A lost answer keeps the same request, so sending again never opens two Stores.
      if (failure !== "OutcomeUnknown") operation.current = null;
      setMessage({
        tone: "alert",
        text:
          failure === "PermissionDenied"
            ? t("Only the brand's owner can open a store.")
            : failure === "CodeTaken"
              ? t("Another store of this brand already uses this code. Choose another code.")
              : failure === "Invalid"
                ? t(
                    "Check the name and code: the code starts with a letter and uses letters, digits, - or _.",
                  )
                : failure === "Conflict"
                  ? t("This store was already opened with other details. Refresh the page.")
                  : t("Not saved. Check the connection and try again."),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <WorkspacePage title={t("Stores")}>
      <div className="stores-page">
        <section aria-labelledby="stores-yours">
          <h2 id="stores-yours">{t("Your stores")}</h2>
          <ul className="stores-page__list">
            {stores.map((store) => (
              <li key={store.storeReference} className="stores-page__row">
                <span>{store.storeLabel}</span>
                {store.storeReference === currentStoreReference ? (
                  <span className="stores-page__current">{t("You are here")}</span>
                ) : (
                  <button
                    type="button"
                    disabled={switching}
                    onClick={() => onSwitchStore(store.storeReference)}
                  >
                    {t("Switch to this store")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
        {mayOpen ? (
          <section aria-labelledby="stores-open">
            <h2 id="stores-open">{t("Open a store")}</h2>
            <p>
              {t(
                "For the brand's owner. The new store gets you as its first staff member; its menu, tables and roles are set up next.",
              )}
            </p>
            <form
              className="stores-page__form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label>
                {t("Store name (as guests see it)")}
                <input
                  value={name}
                  maxLength={160}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                {t("Short code")}
                <input
                  value={code}
                  maxLength={63}
                  required
                  pattern="[A-Za-z][A-Za-z0-9_\\-]*"
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <label>
                {t("Time zone")}
                <select value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
                  {storeOpeningTimeZones.map((zone) => (
                    <option key={zone} value={zone}>
                      {timeZoneText[zone]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("Store language")}
                <select value={locale} onChange={(event) => setLocale(event.target.value)}>
                  {storeOpeningLocales.map((value) => (
                    <option key={value} value={value}>
                      {localeText[value]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={busy}>
                {busy ? t("Opening the store…") : t("Open store")}
              </button>
            </form>
            {message === null ? null : (
              <p
                role={message.tone}
                className={message.tone === "alert" ? "command-error" : undefined}
              >
                {message.text}
              </p>
            )}
          </section>
        ) : null}
      </div>
    </WorkspacePage>
  );
}
