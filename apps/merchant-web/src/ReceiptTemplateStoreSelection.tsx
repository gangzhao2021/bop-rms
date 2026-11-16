import { t } from "./i18n/i18n.js";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useReadAgainWhenOnline } from "./reconnect-read.js";
import { languageName } from "./staff-text.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  createReceiptTemplateDraftClient,
  type ReceiptTemplateDraftRoster,
} from "./receipt-template-draft-client.js";
import {
  createReceiptTemplatePublishedClient,
  parseReceiptTemplatePublishedCurrent,
  type ReceiptTemplatePublishedCurrent,
} from "./receipt-template-published-client.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
  type StoreSetupValue,
} from "./store-setup-client.js";
export interface ReceiptTemplateStoreSelectionProps {
  readonly scope: StoreSetupScope;
  readonly locale: string;
  readonly csrf: string;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly value: StoreSetupValue<string>;
  /** b24: where receipt templates are written and changed (Receipts and tax numbers). */
  readonly editHref?: string;
  /** WP-2423 (v15): the template the live Store issues receipts with today, when known. */
  readonly liveTemplateReference?: string | null;
  readonly onSelect: (templateReference: string | null) => void;
  readonly client?: ReturnType<typeof createReceiptTemplatePublishedClient>;
  readonly rosterClient?: ReturnType<typeof createReceiptTemplateDraftClient>;
  /** WP-2423 (2026-10-16): finds the receipt template the Store started with. Defaults to its own
   * client unless `client` is injected (then only when given). */
  readonly installedClient?: Pick<
    ReturnType<typeof createReceiptTemplatePublishedClient>,
    "loadInstalled"
  >;
}
/** What is known about the receipt template the Store started with (installer-published). */
type InstalledTemplate =
  | { readonly state: "Loading" }
  | { readonly state: "Found"; readonly templateReference: string }
  | { readonly state: "None" }
  | { readonly state: "Unavailable" }
  /** Refused (not an outage): not read again by itself. */
  | { readonly state: "Refused" };
/** b24 review: saved templates are read page after page until the last one. This many pages is far
 * more than a Store keeps; past it the choice says more exist and where to see them (never a silent
 * stop). */
export const RECEIPT_TEMPLATE_PAGE_LIMIT = 50;
export function applyReceiptTemplateStoreSelection(
  current: ReceiptTemplatePublishedCurrent,
  scope: StoreSetupScope,
  locale: string,
  onSelect: (templateReference: string) => void,
) {
  current = parseReceiptTemplatePublishedCurrent(current, scope, current.templateReference, locale);
  if (
    canonical(parseStoreSetupScope(scope)) !==
      canonical({
        tenantReference: current.tenantReference,
        brandReference: current.brandReference,
        storeReference: current.storeReference,
        actorReference: current.actorReference,
      }) ||
    current.locale !== locale
  )
    throw new StoreSetupClientError("ScopeChanged");
  if (Date.now() < Date.parse(current.observedAt) || Date.now() >= Date.parse(current.validUntil))
    throw new StoreSetupClientError("Stale");
  onSelect(current.templateReference);
}
/** WP-2423: the templates offered besides the saved (product-authored) ones, in staff language:
 * the one the Store issues receipts with today, and the one it started with (installer-published,
 * so it is never in the saved list) when that is a different template. */
export function receiptTemplateStoreOptions(input: {
  readonly live: string | null;
  readonly startedWith: string | null;
  readonly saved: readonly string[];
}): readonly { readonly value: string; readonly label: string }[] {
  const options: { value: string; label: string }[] = [];
  if (input.live !== null && !input.saved.includes(input.live))
    options.push({
      value: input.live,
      label:
        input.live === input.startedWith
          ? t("Receipt template in use today (the one the Store started with)")
          : t("Receipt template in use today"),
    });
  if (
    input.startedWith !== null &&
    input.startedWith !== input.live &&
    !input.saved.includes(input.startedWith)
  )
    options.push({ value: input.startedWith, label: t("Receipt template the Store started with") });
  return options;
}
/**
 * b24 (Owner 2026-11-16 "费用、税务和付款这个页面还是很难看"): which receipt template this setup
 * uses, as one choice. Choosing one checks it is published for the Store's language and puts it in
 * the setup at once (Save as draft keeps it); writing or changing a template is in Receipts and tax
 * numbers, reached by `editHref`. Every saved template is read by itself, page after page, and read
 * again once the connection is back after a failed read: there is nothing to refresh by hand.
 */
export function ReceiptTemplateStoreSelection(props: ReceiptTemplateStoreSelectionProps) {
  const defaults = useRef({
      client: createReceiptTemplatePublishedClient(),
      roster: createReceiptTemplateDraftClient(),
      // Its own client: a check of another template never cancels this lookup.
      installed: createReceiptTemplatePublishedClient(),
    }),
    client = props.client ?? defaults.current.client,
    rosterClient = props.rosterClient ?? defaults.current.roster,
    installedClient =
      props.installedClient ??
      (props.client === undefined ? defaults.current.installed : undefined);
  const identity = canonical({ scope: props.scope, locale: props.locale, csrf: props.csrf }),
    identityRef = useRef(identity),
    disabled = useRef(props.disabled);
  identityRef.current = identity;
  disabled.current = props.disabled;
  const previewSequence = useRef(0);
  const epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    [saved, setSaved] = useState<ReceiptTemplateDraftRoster["entries"] | null>(null),
    [rosterError, setRosterError] = useState<StoreSetupClientError["code"] | null>(null),
    [more, setMore] = useState(false),
    [checking, setChecking] = useState(false),
    [error, setError] = useState(""),
    [installed, setInstalled] = useState<InstalledTemplate | null>(null),
    [readAgain, setReadAgain] = useState(0);
  const code = (e: unknown) => (e instanceof StoreSetupClientError ? e.code : "Unavailable");
  const valid = (e: number, key: string, c: AbortController) =>
    epoch.current === e && identityRef.current === key && !c.signal.aborted;
  async function preview(templateReference: string) {
    if (disabled.current || !templateReference) return;
    const sequence = ++previewSequence.current,
      e = epoch.current,
      key = identityRef.current,
      c = new AbortController();
    controllers.current.add(c);
    setChecking(true);
    setError("");
    try {
      const result = await client.load({
        expectedScope: props.scope,
        templateReference,
        locale: props.locale,
        signal: c.signal,
      });
      if (valid(e, key, c) && sequence === previewSequence.current) {
        if (!disabled.current)
          applyReceiptTemplateStoreSelection(result, props.scope, props.locale, props.onSelect);
        setChecking(false);
      }
    } catch (e2) {
      if (valid(e, key, c) && sequence === previewSequence.current) {
        setError(code(e2));
        setChecking(false);
      }
    } finally {
      controllers.current.delete(c);
    }
  }
  useEffect(() => {
    epoch.current++;
    for (const c of controllers.current) c.abort();
    controllers.current.clear();
    setSaved(null);
    setRosterError(null);
    setMore(false);
    setError("");
    setChecking(false);
    const e = epoch.current,
      key = identity,
      c = new AbortController();
    controllers.current.add(c);
    // Initial observation survives a parent Save temporarily disabling controls. Every page of
    // saved templates is read until the last one, so the choice lists them all; a cursor that does
    // not move on, or more pages than any Store keeps, is said below rather than cut off silently.
    void (async () => {
      const entries: ReceiptTemplateDraftRoster["entries"][number][] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      for (let page = 0; ; page++) {
        if (page >= RECEIPT_TEMPLATE_PAGE_LIMIT || (after !== null && seen.has(after))) {
          if (valid(e, key, c)) setMore(true);
          break;
        }
        if (after !== null) seen.add(after);
        const result: ReceiptTemplateDraftRoster = await rosterClient.loadRoster({
          storeReference: props.scope.storeReference,
          expectedScope: props.scope,
          afterTemplate: after,
          csrf: props.csrf,
          signal: c.signal,
        });
        entries.push(...result.entries);
        after = result.nextAfter;
        if (after === null) break;
      }
      if (valid(e, key, c)) setSaved(entries);
    })()
      .catch((e2: unknown) => {
        if (valid(e, key, c)) setRosterError(code(e2));
      })
      .finally(() => controllers.current.delete(c));
    if (installedClient) {
      const i = new AbortController();
      controllers.current.add(i);
      setInstalled({ state: "Loading" });
      void installedClient
        .loadInstalled({ expectedScope: props.scope, locale: props.locale, signal: i.signal })
        .then((result) => {
          if (valid(e, key, i))
            setInstalled(
              result === null
                ? { state: "None" }
                : { state: "Found", templateReference: result.templateReference },
            );
        })
        .catch((e2: unknown) => {
          if (valid(e, key, i))
            setInstalled({ state: code(e2) === "Unavailable" ? "Unavailable" : "Refused" });
        })
        .finally(() => controllers.current.delete(i));
    }
    return () => {
      epoch.current++;
      for (const x of controllers.current) x.abort();
      controllers.current.clear();
    };
  }, [identity, client, rosterClient, installedClient, readAgain]);
  // b24 review: read again by itself only after an outage, never after a refusal.
  const online = useReadAgainWhenOnline(
    rosterError === "Unavailable" || installed?.state === "Unavailable" || error === "Unavailable",
    () => setReadAgain((n) => n + 1),
  );
  const live = props.liveTemplateReference ?? null,
    startedWith = installed?.state === "Found" ? installed.templateReference : null,
    chosen = props.value.state === "Configured" ? props.value.value : "";
  const options = [
    ...receiptTemplateStoreOptions({
      live,
      startedWith,
      saved: (saved ?? []).map((entry) => entry.content.templateReference),
    }),
    ...(saved ?? []).map((entry) => ({
      value: entry.content.templateReference,
      label:
        entry.content.templateReference === live
          ? t("Receipt template in use today")
          : t("{locale} receipt template, version {revision}", {
              locale: languageName(entry.content.locale),
              revision: entry.revision,
            }),
    })),
  ];
  const known = options.some((option) => option.value === chosen);
  const failed =
    (rosterError !== null ||
      installed?.state === "Unavailable" ||
      installed?.state === "Refused") &&
    online;
  return (
    <section
      hidden={props.hidden}
      aria-label={t("Receipts")}
      className="store-setup-receipt store-setup-block"
    >
      <h4>{t("Receipts")}</h4>
      <p className="store-setup-block__lead">
        {live !== null && chosen === live
          ? t("Guests get the receipt this store issues today.")
          : t("The receipt guests get. Choose which template this store uses.")}
      </p>
      <ul className="store-setup-rows">
        <li className="store-setup-row">
          <div className="store-setup-row__head">
            <span className="store-setup-row__name">{t("Receipt template")}</span>
          </div>
          <div className="store-setup-row__fields">
            <label className="store-setup-row__field">
              <span>{t("This store uses")}</span>
              <select
                aria-label={t("Receipt template")}
                disabled={props.disabled || checking}
                value={chosen}
                onChange={(e) => {
                  const value = e.target.value;
                  setError("");
                  if (value === "") {
                    previewSequence.current++;
                    props.onSelect(null);
                  } else void preview(value);
                }}
              >
                <option value="">{t("None chosen yet (needed to publish)")}</option>
                {chosen !== "" && !known ? (
                  <option value={chosen}>{t("The template saved in this setup")}</option>
                ) : null}
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </li>
      </ul>
      <p
        role="status"
        aria-live="polite"
        className="store-setup-block__note store-setup-block__after"
      >
        {checking
          ? t("Checking the receipt template…")
          : error === "Denied"
            ? t("You do not have permission to choose receipt templates. The saved choice is kept.")
            : error === "NotFound"
              ? t(
                  "This template is not published for this store's language yet. The saved choice is kept.",
                )
              : error === "Stale"
                ? t("The check took too long. Choose the template again.")
                : error && online
                  ? t("The template could not be checked. The saved choice is kept.")
                  : ""}
      </p>
      {failed ? (
        <p className="store-setup-block__problem store-setup-block__after">
          {t("Saved receipt templates could not be loaded.")}{" "}
          <button
            type="button"
            className="store-setup-inline-action"
            onClick={() => setReadAgain((n) => n + 1)}
          >
            {t("Try again")}
          </button>
        </p>
      ) : null}
      {more ? (
        <p className="store-setup-block__note store-setup-block__after">
          {t("More receipt templates are saved than are listed here.")}
          {props.editHref === undefined ? null : (
            <>
              {" "}
              <Link to={props.editHref}>{t("See them all in Receipts and tax numbers")}</Link>
            </>
          )}
        </p>
      ) : null}
      {props.editHref !== undefined ? (
        <p className="store-setup-block__after">
          <Link to={props.editHref}>{t("Edit receipt templates")}</Link>
        </p>
      ) : null}
    </section>
  );
}
