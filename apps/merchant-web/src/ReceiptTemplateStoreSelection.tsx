import { t } from "./i18n/i18n.js";
import { useContext, useEffect, useRef, useState } from "react";
import { StoreTimeZoneContext, friendlyStoreTime } from "./StoreTime.js";
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
  | { readonly state: "Unavailable" };
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
  const rosterSequence = useRef(0),
    previewSequence = useRef(0);
  const epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    [roster, setRoster] = useState<ReceiptTemplateDraftRoster | null>(null),
    [candidate, setCandidate] = useState<ReceiptTemplatePublishedCurrent | null>(null),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [expired, setExpired] = useState(false),
    [installed, setInstalled] = useState<InstalledTemplate | null>(null),
    installedSequence = useRef(0);
  const code = (e: unknown) => (e instanceof StoreSetupClientError ? e.code : "Unavailable");
  const timeZone = useContext(StoreTimeZoneContext);
  const valid = (e: number, key: string, c: AbortController) =>
    epoch.current === e && identityRef.current === key && !c.signal.aborted;
  /** WP-2423 (2026-10-16): the receipt template the Store started with, read from its actual
   * current Publishing release (so the Owner can always go back to it). */
  function loadInstalled() {
    if (!installedClient) return;
    const sequence = ++installedSequence.current,
      e = epoch.current,
      key = identityRef.current,
      c = new AbortController();
    controllers.current.add(c);
    setInstalled({ state: "Loading" });
    void installedClient
      .loadInstalled({ expectedScope: props.scope, locale: props.locale, signal: c.signal })
      .then((result) => {
        if (valid(e, key, c) && sequence === installedSequence.current)
          setInstalled(
            result === null
              ? { state: "None" }
              : { state: "Found", templateReference: result.templateReference },
          );
      })
      .catch(() => {
        if (valid(e, key, c) && sequence === installedSequence.current)
          setInstalled({ state: "Unavailable" });
      })
      .finally(() => controllers.current.delete(c));
  }
  async function loadRoster(after: string | null) {
    if (disabled.current) return;
    const sequence = ++rosterSequence.current,
      e = epoch.current,
      key = identityRef.current,
      c = new AbortController();
    controllers.current.add(c);
    setBusy(true);
    setError("");
    try {
      const result = await rosterClient.loadRoster({
        storeReference: props.scope.storeReference,
        expectedScope: props.scope,
        afterTemplate: after,
        csrf: props.csrf,
        signal: c.signal,
      });
      if (valid(e, key, c) && sequence === rosterSequence.current) {
        setRoster(result);
        setBusy(false);
      }
    } catch (e2) {
      if (valid(e, key, c) && sequence === rosterSequence.current) {
        setError(code(e2));
        setBusy(false);
      }
    } finally {
      controllers.current.delete(c);
    }
  }
  async function preview(templateReference: string, apply = false) {
    if (disabled.current || !templateReference) return;
    const sequence = ++previewSequence.current,
      e = epoch.current,
      key = identityRef.current,
      c = new AbortController();
    controllers.current.add(c);
    setBusy(true);
    setError("");
    setCandidate(null);
    try {
      const result = await client.load({
        expectedScope: props.scope,
        templateReference,
        locale: props.locale,
        signal: c.signal,
      });
      if (valid(e, key, c) && sequence === previewSequence.current) {
        if (!disabled.current) {
          setCandidate(result);
          setExpired(false);
          // WP-2423 (v15): "Keep the receipt template in use today" checks and keeps it at once.
          if (apply) {
            applyReceiptTemplateStoreSelection(result, props.scope, props.locale, props.onSelect);
            setSelected(templateReference);
          }
        }
        setBusy(false);
      }
    } catch (e2) {
      if (valid(e, key, c) && sequence === previewSequence.current) {
        setError(code(e2));
        setBusy(false);
      }
    } finally {
      controllers.current.delete(c);
    }
  }
  useEffect(() => {
    epoch.current++;
    for (const c of controllers.current) c.abort();
    controllers.current.clear();
    setRoster(null);
    setCandidate(null);
    setSelected(props.value.state === "Configured" ? props.value.value : "");
    setError("");
    setBusy(false);
    const sequence = ++rosterSequence.current,
      e = epoch.current,
      key = identity,
      c = new AbortController();
    controllers.current.add(c);
    // Initial observation survives a parent Save temporarily disabling controls.
    void rosterClient
      .loadRoster({
        storeReference: props.scope.storeReference,
        expectedScope: props.scope,
        afterTemplate: null,
        csrf: props.csrf,
        signal: c.signal,
      })
      .then((result) => {
        if (valid(e, key, c) && sequence === rosterSequence.current) setRoster(result);
      })
      .catch((e2) => {
        if (valid(e, key, c) && sequence === rosterSequence.current) setError(code(e2));
      })
      .finally(() => controllers.current.delete(c));
    setInstalled(null);
    loadInstalled();
    return () => {
      epoch.current++;
      for (const x of controllers.current) x.abort();
      controllers.current.clear();
    };
  }, [identity, client, rosterClient, installedClient]);
  useEffect(() => {
    if (!candidate) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(candidate.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [candidate]);
  const live = props.liveTemplateReference ?? null,
    usingLive = live !== null && props.value.state === "Configured" && props.value.value === live,
    startedWith = installed?.state === "Found" ? installed.templateReference : null,
    usingStartedWith =
      startedWith !== null &&
      props.value.state === "Configured" &&
      props.value.value === startedWith;
  const blocked = props.disabled || busy,
    fresh =
      candidate !== null &&
      !expired &&
      Date.now() >= Date.parse(candidate.observedAt) &&
      Date.now() < Date.parse(candidate.validUntil);
  return (
    <section
      hidden={props.hidden}
      aria-label={t("Published receipt template selection")}
      className="store-setup-reference-editor"
    >
      <h4>{t("Published receipt template")}</h4>
      <p>
        {t(
          "Keep the template the Store issues receipts with today, or choose a saved template and check its currently effective version for this store language. Save the setup draft separately to keep the selection.",
        )}
      </p>
      {live !== null && (
        <div>
          <p>
            {usingLive
              ? t("This setup uses the receipt template the Store issues receipts with today.")
              : t(
                  "The Store issues receipts with a published template today. Keep it unless you want customers' receipts to change.",
                )}
          </p>
          <button
            type="button"
            disabled={blocked || usingLive}
            onClick={() => {
              previewSequence.current++;
              setError("");
              void preview(live, true);
            }}
          >
            {t("Keep the receipt template in use today")}
          </button>
        </div>
      )}
      {startedWith !== null && startedWith !== live && (
        <div>
          <p>
            {usingStartedWith
              ? t("This setup goes back to the receipt template the Store started with.")
              : t("You can go back to the receipt template the Store started with.")}
          </p>
          <button
            type="button"
            disabled={blocked || usingStartedWith}
            onClick={() => {
              previewSequence.current++;
              setError("");
              void preview(startedWith, true);
            }}
          >
            {t("Use the receipt template the Store started with")}
          </button>
        </div>
      )}
      <label>
        {t("Saved templates")}
        <select
          aria-label={t("Saved templates")}
          disabled={blocked}
          value={selected}
          onChange={(e) => {
            previewSequence.current++;
            setSelected(e.target.value);
            setCandidate(null);
            setError("");
          }}
        >
          <option value="">{t("Choose a saved template")}</option>
          {receiptTemplateStoreOptions({
            live,
            startedWith,
            saved: (roster?.entries ?? []).map((entry) => entry.content.templateReference),
          }).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {roster?.entries.map((entry) => (
            <option key={entry.content.templateReference} value={entry.content.templateReference}>
              {t("{locale} · draft {revision}", {
                locale: languageName(entry.content.locale),
                revision: entry.revision,
              })}
            </option>
          ))}
        </select>
      </label>
      <div className="store-setup-actions">
        <button
          type="button"
          disabled={blocked}
          onClick={() => {
            void loadRoster(null);
            loadInstalled();
          }}
        >
          {t("Refresh saved templates")}
        </button>
        <button
          type="button"
          disabled={blocked || !roster?.nextAfter}
          onClick={() => void loadRoster(roster?.nextAfter ?? null)}
        >
          {t("Next saved templates")}
        </button>
        <button
          type="button"
          disabled={blocked || !selected}
          onClick={() => void preview(selected)}
        >
          {t("Check published receipt template")}
        </button>
      </div>
      <p role="status" aria-live="polite">
        {busy
          ? t("Loading published receipt template…")
          : error
            ? error === "Denied"
              ? t(
                  "You do not have permission to choose receipt templates. The saved selection is kept.",
                )
              : error === "NotFound"
                ? t(
                    "This template has not been published for this Store's language yet. The saved selection is kept.",
                  )
                : t(
                    "Published receipt templates could not be loaded. Refresh to try again; the saved selection is kept.",
                  )
            : expired
              ? t("This check is out of date. Check the published template again.")
              : ""}
      </p>
      {installed?.state === "Unavailable" && (
        <p>
          {t(
            "The receipt template the Store started with could not be checked now. Refresh saved templates to try again.",
          )}
        </p>
      )}
      {candidate && (
        <div>
          <p>
            {t("{locale} · published version {versionNumber}", {
              locale: languageName(candidate.currentVersion.locale),
              versionNumber: candidate.currentVersion.versionNumber,
            })}
          </p>
          <p>
            {t("In use from {effectiveFrom}{value}", {
              effectiveFrom: friendlyStoreTime(candidate.currentVersion.effectiveFrom, timeZone),
              value: candidate.currentVersion.effectiveUntil
                ? t(" until {effectiveUntil}", {
                    effectiveUntil: friendlyStoreTime(
                      candidate.currentVersion.effectiveUntil,
                      timeZone,
                    ),
                  })
                : "",
            })}
          </p>
          <p>{t("This template has not been checked by a tax or legal professional.")}</p>
          <button
            type="button"
            disabled={blocked || !fresh}
            onClick={() => {
              if (disabled.current) return;
              try {
                applyReceiptTemplateStoreSelection(
                  candidate,
                  props.scope,
                  props.locale,
                  props.onSelect,
                );
              } catch (e) {
                setError(code(e));
              }
            }}
          >
            {t("Use published receipt template")}
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={blocked}
        onClick={() => {
          if (!disabled.current) {
            setCandidate(null);
            props.onSelect(null);
          }
        }}
      >
        {t("Clear receipt template choice")}
      </button>
      <p>{t("A setup without a receipt template can be saved, but it cannot be published.")}</p>
    </section>
  );
}
