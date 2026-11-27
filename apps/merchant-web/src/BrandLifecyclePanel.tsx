import { useEffect, useMemo, useRef, useState } from "react";
import {
  createMerchantBrandLifecycleClient,
  BrandLifecycleClientError,
  type MerchantBrandLifecycleClient,
  type BrandLifecycleOriginal,
  type BrandLifecycleAction,
  parseBrandLifecycleScope,
} from "./merchant-brand-lifecycle-client.js";
import {
  createBrandLifecycleJournal,
  type BrandLifecycleJournal,
} from "./brand-lifecycle-journal.js";
import type { MerchantBrandScope } from "./merchant-brand-workspace.js";
export interface BrandLifecyclePanelProps {
  readonly scope: MerchantBrandScope;
  readonly csrf: string;
  readonly brand: {
    readonly label: string;
    readonly lifecycle: "Draft" | "Active" | "Suspended" | "Archived";
    readonly version: number;
  };
  readonly onRefresh: () => void;
  readonly client?: MerchantBrandLifecycleClient;
  readonly journalFactory?: (scope: MerchantBrandScope) => BrandLifecycleJournal;
  readonly freshDisabled?: boolean;
}
const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
export function BrandLifecyclePanel(props: BrandLifecyclePanelProps) {
  const scope = useMemo(
      () => parseBrandLifecycleScope(props.scope),
      [props.scope.tenantReference, props.scope.brandReference, props.scope.actorReference],
    ),
    client = useMemo(() => props.client ?? createMerchantBrandLifecycleClient(), [props.client]),
    journal = useMemo(
      () => (props.journalFactory ?? createBrandLifecycleJournal)(scope),
      [scope, props.journalFactory],
    ),
    [pending, setPending] = useState<BrandLifecycleOriginal | null>(null),
    [action, setAction] = useState<BrandLifecycleAction | null>(null),
    [confirmation, setConfirmation] = useState(false),
    [status, setStatus] = useState("Loading"),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    epoch = useRef(0),
    running = useRef(false),
    controller = useRef<AbortController | null>(null),
    latest = useRef(props);
  latest.current = props;
  const owns = (
    generation: number,
    c: AbortController,
    csrf: string,
    version: number,
    recovery: boolean,
  ) => {
    const p = latest.current;
    return (
      generation === epoch.current &&
      !c.signal.aborted &&
      online() &&
      !p.freshDisabled &&
      p.csrf === csrf &&
      p.scope.tenantReference === scope.tenantReference &&
      p.scope.actorReference === scope.actorReference &&
      p.scope.brandReference === scope.brandReference &&
      (recovery || p.brand.version === version) &&
      p.client === props.client &&
      p.journalFactory === props.journalFactory
    );
  };
  useEffect(() => {
    const generation = ++epoch.current;
    controller.current?.abort();
    client.invalidate();
    running.current = false;
    setBusy(false);
    setAction(null);
    setConfirmation(false);
    setReady(false);
    setPending(null);
    setStatus("Loading");
    void journal
      .load()
      .then((value) => {
        if (generation === epoch.current) {
          setPending(value);
          setReady(true);
          setStatus(value ? "Pending" : "Ready");
        }
      })
      .catch(() => {
        if (generation === epoch.current) setStatus("Unavailable");
      });
    const offline = () => {
      epoch.current++;
      controller.current?.abort();
      client.invalidate();
      running.current = false;
      setBusy(false);
      setStatus("Offline");
    };
    window.addEventListener("offline", offline);
    return () => {
      epoch.current++;
      controller.current?.abort();
      client.invalidate();
      window.removeEventListener("offline", offline);
    };
  }, [scope, props.csrf, client, journal]);
  const execute = async (recovery: boolean) => {
    if (
      running.current ||
      !ready ||
      props.freshDisabled ||
      !online() ||
      (!recovery && (!action || !confirmation || pending)) ||
      (recovery && !pending)
    )
      return;
    const c = new AbortController(),
      generation = epoch.current,
      capturedCsrf = props.csrf,
      version = props.brand.version;
    controller.current = c;
    running.current = true;
    setBusy(true);
    setStatus(recovery ? "Retrying" : "Reserving");
    let original = pending;
    try {
      const stored = await journal.load();
      if (!owns(generation, c, capturedCsrf, version, recovery))
        throw new BrandLifecycleClientError("ScopeChanged");
      if (recovery) {
        if (!stored || !original || JSON.stringify(stored) !== JSON.stringify(original))
          throw new BrandLifecycleClientError("Conflict");
        original = stored;
      } else {
        if (stored) {
          setPending(stored);
          setStatus("Pending");
          return;
        }
        if (!action) throw new BrandLifecycleClientError("Invalid");
        original = client.prepare(scope, action, version);
        await journal.reserve(original);
        if (generation === epoch.current) setPending(original);
        const reserved = await journal.load();
        if (!reserved || JSON.stringify(reserved) !== JSON.stringify(original))
          throw new BrandLifecycleClientError("Conflict");
      }
      if (!original || !owns(generation, c, capturedCsrf, version, recovery))
        throw new BrandLifecycleClientError("ScopeChanged");
      setStatus("Sending");
      const receipt = await client.execute(original, scope, {
        csrf: capturedCsrf,
        signal: c.signal,
      });
      if (!owns(generation, c, capturedCsrf, version, recovery))
        throw new BrandLifecycleClientError("ScopeChanged");
      await journal.complete(original, receipt, () =>
        owns(generation, c, capturedCsrf, version, true),
      );
      if (!owns(generation, c, capturedCsrf, version, true))
        throw new BrandLifecycleClientError("ScopeChanged");
      setPending(null);
      setAction(null);
      setConfirmation(false);
      setStatus("Completed");
      props.onRefresh();
    } catch (error) {
      if (
        error instanceof BrandLifecycleClientError &&
        error.code === "RequestConflict" &&
        original &&
        owns(generation, c, capturedCsrf, version, true)
      ) {
        try {
          await journal.releaseConflict(original, error, () =>
            owns(generation, c, capturedCsrf, version, true),
          );
          if (owns(generation, c, capturedCsrf, version, true)) {
            setPending(null);
            setAction(null);
            setConfirmation(false);
            setStatus("RequestConflict");
            props.onRefresh();
          }
          return;
        } catch {
          if (generation === epoch.current) setStatus("Unavailable");
          return;
        }
      }
      if (generation === epoch.current) {
        setStatus(
          !online()
            ? "Offline"
            : error instanceof BrandLifecycleClientError
              ? error.code
              : "Unavailable",
        );
        try {
          const stored = await journal.load();
          if (generation === epoch.current) {
            setPending(stored);
            if (stored === null) setReady(false);
          }
        } catch {
          if (generation === epoch.current) setReady(false);
        }
      }
    } finally {
      if (generation === epoch.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const disabled =
    busy ||
    !ready ||
    !!props.freshDisabled ||
    !online() ||
    status === "Offline" ||
    status === "ScopeChanged";
  return (
    <section aria-label="Brand lifecycle">
      <h2>Brand lifecycle</h2>
      <p>
        Current {props.brand.label}: {props.brand.lifecycle} · version {props.brand.version}
      </p>
      <p role="status">
        {status === "Loading"
          ? "Loading original lifecycle request…"
          : status === "Ready"
            ? "Choose a lifecycle action for the current Brand."
            : status === "Pending"
              ? "An original lifecycle request must be recovered before starting another action."
              : status === "OutcomeUnknown"
                ? "Result unknown. Retry only the saved original request after refreshing Brand access."
                : status === "Denied"
                  ? "Current authority or recent verification is required. Refresh or renew your session, then retry the saved original."
                  : status === "RequestConflict"
                    ? "The server confirmed this original request cannot apply. Refreshing current Brand before a new explicit action."
                    : status === "Conflict"
                      ? "The original request conflicts with current authority or version. It remains saved; no new action was created."
                      : status === "Offline"
                        ? "Offline. The original request stays saved. Reconnect and refresh Brand access to retry."
                        : status === "Completed"
                          ? "Original operation confirmed. Refreshing the current Brand status."
                          : status === "Sending" || status === "Retrying" || status === "Reserving"
                            ? "Confirming the original lifecycle operation…"
                            : status === "Unavailable"
                              ? "Lifecycle access or durable recovery is unavailable. Refresh access before retrying."
                              : "Brand scope changed. Refresh access before retrying."}
      </p>
      {pending ? (
        <>
          <p>
            Saved original: {pending.action === "ActivateBrand" ? "Activate" : "Archive"} this Brand
            from version {pending.expectedBrandVersion}. The current status above may have advanced
            since this request.
          </p>
          <button type="button" disabled={disabled} onClick={() => void execute(true)}>
            Retry original lifecycle request
          </button>
        </>
      ) : (
        <>
          {props.brand.lifecycle === "Draft" || props.brand.lifecycle === "Suspended" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setAction("ActivateBrand");
                setConfirmation(false);
              }}
            >
              Activate Brand
            </button>
          ) : null}
          {props.brand.lifecycle !== "Archived" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setAction("ArchiveBrand");
                setConfirmation(false);
              }}
            >
              Archive Brand
            </button>
          ) : null}
          {action ? (
            <fieldset disabled={disabled}>
              <legend>
                Confirm {action === "ActivateBrand" ? "activation" : "archival"} of{" "}
                {props.brand.label}
              </legend>
              <p>
                {action === "ActivateBrand"
                  ? "This changes the Brand lifecycle to Active."
                  : "This archives the Brand. Operational access remains subject to its owning rules."}{" "}
                Expected Brand version {props.brand.version}.
              </p>
              <label className="brand-configuration-checkbox">
                <input
                  type="checkbox"
                  checked={confirmation}
                  onChange={(event) => setConfirmation(event.target.checked)}
                />
                I confirm {action === "ActivateBrand" ? "activating" : "archiving"}{" "}
                {props.brand.label}.
              </label>
              <button
                type="button"
                disabled={disabled || !confirmation}
                onClick={() => void execute(false)}
              >
                Confirm {action === "ActivateBrand" ? "Activate" : "Archive"} Brand
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setAction(null);
                  setConfirmation(false);
                }}
              >
                Cancel lifecycle action
              </button>
            </fieldset>
          ) : null}
        </>
      )}
    </section>
  );
}
