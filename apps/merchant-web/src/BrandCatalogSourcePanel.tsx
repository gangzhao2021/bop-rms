import { useEffect, useMemo, useRef, useState } from "react";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  BrandCatalogSourceClientError,
  createMerchantBrandCatalogSourceClient,
  parseBrandCatalogSourceCurrent,
  type BrandCatalogSourceScope,
  type BrandCatalogSourceResolve,
  type BrandCatalogSourceCurrent,
  type PreparedBrandCatalogSource,
} from "./merchant-brand-catalog-source-client.js";
import {
  createBrandCatalogSourcePendingJournal,
  type BrandCatalogSourcePendingJournal,
} from "./brand-catalog-source-pending-journal.js";
export interface BrandCatalogSourcePanelProps {
  readonly scope: BrandCatalogSourceScope;
  readonly csrf: string;
  readonly freshDisabled?: boolean;
  readonly client?: ReturnType<typeof createMerchantBrandCatalogSourceClient>;
  readonly journalFactory?: (scope: BrandCatalogSourceScope) => BrandCatalogSourcePendingJournal;
}
interface OriginalInput {
  client: ReturnType<typeof createMerchantBrandCatalogSourceClient>;
  journal: BrandCatalogSourcePendingJournal;
  scope: BrandCatalogSourceScope;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
const changed = (): never => {
  throw new BrandCatalogSourceClientError("ScopeChanged");
};
export async function finishBrandCatalogSourceOriginal(
  input: OriginalInput & {
    cursor: BrandCatalogSourceResolve;
    prepared?: PreparedBrandCatalogSource;
  },
) {
  const check = () => {
    if (input.signal.aborted || !input.isCurrent()) changed();
  };
  check();
  if (
    input.cursor.tenantReference !== input.scope.tenantReference ||
    input.cursor.brandReference !== input.scope.brandReference ||
    input.cursor.actorReference !== input.scope.actorReference
  )
    changed();
  const options = { csrf: input.csrf, signal: input.signal };
  const receipt = input.prepared
    ? await input.client.execute(input.prepared, options)
    : await input.client.resolve(input.cursor, options);
  check();
  const current = await input.client.current(input.scope, options);
  check();
  const exact = receipt.source
    ? await input.client.exact(input.scope, receipt.source.sourceReference, options)
    : null;
  check();
  await input.journal.complete(input.cursor, receipt, current, exact);
  check();
  return { receipt, current };
}
export async function executeBrandCatalogSourceOriginal(
  input: OriginalInput & {
    prepared: PreparedBrandCatalogSource;
    canDispatch: () => boolean;
    onReserved: (cursor: BrandCatalogSourceResolve) => void;
  },
) {
  if (input.signal.aborted || !input.isCurrent()) changed();
  await input.journal.reserve(input.prepared.cursor);
  input.onReserved(input.prepared.cursor);
  if (input.signal.aborted || !input.isCurrent()) changed();
  if (
    !input.canDispatch() ||
    canonical(await input.journal.load()) !== canonical(input.prepared.cursor)
  )
    throw new BrandCatalogSourceClientError("Conflict");
  if (input.signal.aborted || !input.isCurrent()) changed();
  if (!input.canDispatch()) throw new BrandCatalogSourceClientError("Conflict");
  return finishBrandCatalogSourceOriginal({ ...input, cursor: input.prepared.cursor });
}
function message(error: unknown) {
  if (error instanceof BrandCatalogSourceClientError && error.code === "Denied")
    return "Current access refused this request. Restore access before recovering the original.";
  if (error instanceof BrandCatalogSourceClientError && error.code === "ScopeChanged")
    return "The Brand or Actor changed. Return to the original scope to recover its request.";
  return "The result could not be confirmed. Refresh or recover the original request before registering again.";
}
/** The registered catalogue identity carries no publication or eligibility grant. */
export function BrandCatalogSourcePanel(props: BrandCatalogSourcePanelProps) {
  const client = useMemo(
    () => props.client ?? createMerchantBrandCatalogSourceClient(),
    [props.client],
  );
  const identity = canonical(props.scope) + props.csrf,
    generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    journal = useRef<BrandCatalogSourcePendingJournal | null>(null),
    running = useRef(false);
  const live = useRef({ identity, disabled: props.freshDisabled, code: "", label: "" });
  const [current, setCurrent] = useState<BrandCatalogSourceCurrent | null>(null),
    [pending, setPending] = useState<BrandCatalogSourceResolve | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [code, setCode] = useState(""),
    [label, setLabel] = useState(""),
    [expired, setExpired] = useState(true),
    [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  live.current = { identity, disabled: props.freshDisabled, code, label };
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    const epoch = ++generation.current,
      c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    client.invalidate();
    running.current = false;
    setCurrent(null);
    setPending(null);
    setError(null);
    setNotice(null);
    setCode("");
    setLabel("");
    setBusy(true);
    setExpired(true);
    const selected = (props.journalFactory ?? createBrandCatalogSourcePendingJournal)(props.scope);
    journal.current = selected;
    const valid = () =>
      generation.current === epoch && !c.signal.aborted && live.current.identity === identity;
    void (async () => {
      try {
        const original = await selected.load();
        if (!valid()) return;
        setPending(original);
        const fresh = await client.current(props.scope, { csrf: props.csrf, signal: c.signal });
        if (valid()) setCurrent(fresh);
      } catch (e) {
        if (valid()) setError(message(e));
      } finally {
        if (valid()) setBusy(false);
      }
    })();
    return () => {
      ++generation.current;
      c.abort();
      client.invalidate();
    };
  }, [identity, client, props.journalFactory]);
  useEffect(() => {
    if (!current) {
      setExpired(true);
      return;
    }
    setExpired(
      Date.now() < Date.parse(current.observedAt) || Date.now() >= Date.parse(current.validUntil),
    );
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(current.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [current]);
  async function act(mode: "Refresh" | "Register" | "Recover") {
    if (running.current || !journal.current || !online) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const epoch = ++generation.current,
      c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    const selected = journal.current,
      captured = { scope: props.scope, csrf: props.csrf, code, label };
    const valid = () =>
      epoch === generation.current && !c.signal.aborted && live.current.identity === identity;
    try {
      const original = await selected.load();
      if (!valid()) changed();
      setPending(original);
      if (mode === "Refresh") {
        const fresh = await client.current(captured.scope, {
          csrf: captured.csrf,
          signal: c.signal,
        });
        if (valid()) setCurrent(fresh);
        return;
      }
      let result;
      const base = {
        client,
        journal: selected,
        scope: captured.scope,
        csrf: captured.csrf,
        signal: c.signal,
        isCurrent: valid,
      };
      if (mode === "Recover") {
        if (!original) throw new BrandCatalogSourceClientError("Conflict");
        result = await finishBrandCatalogSourceOriginal({ ...base, cursor: original });
      } else {
        if (original || live.current.disabled || !current || current.source)
          throw new BrandCatalogSourceClientError("Conflict");
        parseBrandCatalogSourceCurrent(current, captured.scope, new Date(Date.now()).toISOString());
        const prepared = await client.prepare(captured.scope, {
          operationReference: serviceOperationReference(),
          code: captured.code,
          label: captured.label,
        });
        result = await executeBrandCatalogSourceOriginal({
          ...base,
          prepared,
          onReserved: (cursor) => {
            if (valid()) setPending(cursor);
          },
          canDispatch: () =>
            valid() &&
            !live.current.disabled &&
            live.current.code === captured.code &&
            live.current.label === captured.label &&
            navigator.onLine &&
            Date.now() >= Date.parse(current.observedAt) &&
            Date.now() < Date.parse(current.validUntil),
        });
      }
      if (valid()) {
        setCurrent(result.current);
        setPending(null);
        setNotice(
          result.receipt.outcome === "Committed"
            ? "Catalogue source registered and confirmed."
            : "The original request was abandoned. You may refresh and register a new source.",
        );
      }
    } catch (e) {
      if (valid()) setError(message(e));
    } finally {
      if (valid()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const disabled = busy || !online;
  return (
    <section aria-labelledby="brand-catalog-source-title">
      <h2 id="brand-catalog-source-title">Catalogue source</h2>
      <p>
        Registration identifies this Brand’s existing catalogue. Publication and reference
        eligibility have not been evaluated.
      </p>
      {current?.source ? (
        <dl>
          <dt>Code</dt>
          <dd>{current.source.code}</dd>
          <dt>Label</dt>
          <dd>{current.source.label}</dd>
          <dt>Status</dt>
          <dd>Registered identity</dd>
        </dl>
      ) : (
        <p>
          {current
            ? "No catalogue source is registered."
            : "Current catalogue source has not been confirmed."}
        </p>
      )}
      {!online && <p role="status">Offline. Keep pending requests until access is restored.</p>}
      {pending && (
        <p role="status">
          A registration request is pending. Recover its original result before registering again.
        </p>
      )}
      {expired && current && (
        <p role="status">The current observation expired. Refresh before registering.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="button" disabled={disabled} onClick={() => void act("Refresh")}>
        Refresh catalogue source
      </button>
      <button type="button" disabled={disabled || !pending} onClick={() => void act("Recover")}>
        Recover registration
      </button>
      {!current?.source && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act("Register");
          }}
        >
          <label>
            Catalogue code
            <input
              value={code}
              maxLength={64}
              disabled={disabled || !!pending}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <label>
            Catalogue label
            <input
              value={label}
              maxLength={200}
              disabled={disabled || !!pending}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={
              disabled ||
              !!pending ||
              !!props.freshDisabled ||
              expired ||
              !current ||
              !code.trim() ||
              !label.trim()
            }
          >
            Register catalogue source
          </button>
        </form>
      )}
    </section>
  );
}
