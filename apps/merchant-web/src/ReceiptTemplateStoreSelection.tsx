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
}
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
export function ReceiptTemplateStoreSelection(props: ReceiptTemplateStoreSelectionProps) {
  const defaults = useRef({
      client: createReceiptTemplatePublishedClient(),
      roster: createReceiptTemplateDraftClient(),
    }),
    client = props.client ?? defaults.current.client,
    rosterClient = props.rosterClient ?? defaults.current.roster;
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
    [expired, setExpired] = useState(false);
  const code = (e: unknown) => (e instanceof StoreSetupClientError ? e.code : "Unavailable");
  const timeZone = useContext(StoreTimeZoneContext);
  const valid = (e: number, key: string, c: AbortController) =>
    epoch.current === e && identityRef.current === key && !c.signal.aborted;
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
    return () => {
      epoch.current++;
      for (const x of controllers.current) x.abort();
      controllers.current.clear();
    };
  }, [identity, client, rosterClient]);
  useEffect(() => {
    if (!candidate) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(candidate.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [candidate]);
  const live = props.liveTemplateReference ?? null,
    liveListed =
      live !== null &&
      (roster?.entries ?? []).some((entry) => entry.content.templateReference === live),
    usingLive = live !== null && props.value.state === "Configured" && props.value.value === live;
  const blocked = props.disabled || busy,
    fresh =
      candidate !== null &&
      !expired &&
      Date.now() >= Date.parse(candidate.observedAt) &&
      Date.now() < Date.parse(candidate.validUntil);
  return (
    <section
      hidden={props.hidden}
      aria-label="Published receipt template selection"
      className="store-setup-reference-editor"
    >
      <h4>Published receipt template</h4>
      <p>
        Keep the template the Store issues receipts with today, or choose a saved template and check
        its currently effective version for this store language. Save the setup draft separately to
        keep the selection.
      </p>
      {live !== null && (
        <div>
          <p>
            {usingLive
              ? "This setup uses the receipt template the Store issues receipts with today."
              : "The Store issues receipts with a published template today. Keep it unless you want customers' receipts to change."}
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
            Keep the receipt template in use today
          </button>
        </div>
      )}
      <label>
        Saved templates
        <select
          aria-label="Saved templates"
          disabled={blocked}
          value={selected}
          onChange={(e) => {
            previewSequence.current++;
            setSelected(e.target.value);
            setCandidate(null);
            setError("");
          }}
        >
          <option value="">Choose a saved template</option>
          {live !== null && !liveListed && (
            <option value={live}>Receipt template in use today</option>
          )}
          {roster?.entries.map((entry) => (
            <option key={entry.content.templateReference} value={entry.content.templateReference}>
              {languageName(entry.content.locale)} · draft {entry.revision}
            </option>
          ))}
        </select>
      </label>
      <div className="store-setup-actions">
        <button type="button" disabled={blocked} onClick={() => void loadRoster(null)}>
          Refresh saved templates
        </button>
        <button
          type="button"
          disabled={blocked || !roster?.nextAfter}
          onClick={() => void loadRoster(roster?.nextAfter ?? null)}
        >
          Next saved templates
        </button>
        <button
          type="button"
          disabled={blocked || !selected}
          onClick={() => void preview(selected)}
        >
          Check published receipt template
        </button>
      </div>
      <p role="status" aria-live="polite">
        {busy
          ? "Loading published receipt template…"
          : error
            ? error === "Denied"
              ? "You do not have permission to choose receipt templates. The saved selection is kept."
              : error === "NotFound"
                ? "This template has not been published for this Store's language yet. The saved selection is kept."
                : "Published receipt templates could not be loaded. Refresh to try again; the saved selection is kept."
            : expired
              ? "This check is out of date. Check the published template again."
              : ""}
      </p>
      {candidate && (
        <div>
          <p>
            {languageName(candidate.currentVersion.locale)} · published version{" "}
            {candidate.currentVersion.versionNumber}
          </p>
          <p>
            In use from {friendlyStoreTime(candidate.currentVersion.effectiveFrom, timeZone)}
            {candidate.currentVersion.effectiveUntil
              ? ` until ${friendlyStoreTime(candidate.currentVersion.effectiveUntil, timeZone)}`
              : ""}
          </p>
          <p>This template has not been checked by a tax or legal professional.</p>
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
            Use published receipt template
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
        Clear receipt template choice
      </button>
      <p>A setup without a receipt template can be saved, but it cannot be published.</p>
    </section>
  );
}
