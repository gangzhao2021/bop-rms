import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  createStoreCapabilityClient,
  storeCapabilityChoices,
  StoreCapabilityClientError,
  type StoreCapabilityClient,
  type StoreCapabilityObservation,
  type StoreCapabilityScope,
} from "./store-capability-client.js";

type State =
  | { kind: "Loading" | "Offline" | "FeatureDisabled" | StoreCapabilityClientError["code"] }
  | { kind: "Found"; view: StoreCapabilityObservation };
export function CurrentStoreCapabilityPage({
  scope,
  csrf,
  storeLabel,
  client: injected,
}: {
  readonly scope: StoreCapabilityScope;
  readonly csrf: string;
  readonly storeLabel: string;
  readonly client?: StoreCapabilityClient;
}) {
  const { id } = useParams(),
    client = useMemo(() => injected ?? createStoreCapabilityClient(), [injected]);
  const [key, setKey] = useState("catalog.cat_product_edit"),
    [refresh, setRefresh] = useState(0),
    [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    const controller = new AbortController();
    let active = true,
      staleTimer: ReturnType<typeof setTimeout> | undefined;
    const offline = () => {
      controller.abort();
      if (active) setState({ kind: "Offline" });
    };
    window.addEventListener("offline", offline);
    if (id !== scope.storeReference) setState({ kind: "ScopeChanged" });
    else if (!navigator.onLine) setState({ kind: "Offline" });
    else {
      setState({ kind: "Loading" });
      void client
        .load({ scope, csrf, capabilityKey: "organization.store_capability" }, controller.signal)
        .then(async (gate) => {
          if (!active || controller.signal.aborted) return;
          if (gate.backendExecution !== "Allow") {
            setState({ kind: "FeatureDisabled" });
            return;
          }
          const view =
            key === "organization.store_capability"
              ? gate
              : await client.load(
                  {
                    scope: {
                      storeReference: scope.storeReference,
                      brandReference: gate.brandReference,
                    },
                    csrf,
                    capabilityKey: key,
                  },
                  controller.signal,
                );
          if (!active || controller.signal.aborted) return;
          if (Date.now() - Date.parse(gate.observedAt) > 5000) {
            setState({ kind: "Stale" });
            return;
          }
          setState({ kind: "Found", view });
          staleTimer = setTimeout(
            () => {
              if (active) setState({ kind: "Stale" });
            },
            Math.max(
              0,
              Math.min(Date.parse(gate.observedAt), Date.parse(view.observedAt)) +
                5000 -
                Date.now(),
            ),
          );
        })
        .catch((error: unknown) => {
          if (active && !controller.signal.aborted)
            setState({
              kind: error instanceof StoreCapabilityClientError ? error.code : "Unavailable",
            });
        });
    }
    return () => {
      active = false;
      controller.abort();
      clearTimeout(staleTimer);
      window.removeEventListener("offline", offline);
    };
  }, [client, csrf, id, key, refresh, scope]);
  const copy = {
    Loading: "Loading current capability…",
    Offline: "Offline. Connect and refresh before relying on a capability result.",
    Denied: "Permission is required for this Store.",
    FeatureDisabled:
      "Store capability administration is disabled or its current eligibility is unavailable.",
    Unavailable: "Current capability facts could not be loaded. No enablement was inferred.",
    Stale: "This capability observation has expired. Refresh to check the current result.",
    ScopeChanged: "Select this Store in the workspace before checking its capabilities.",
  };
  return (
    <AppFrame
      title="Store capabilities"
      description={`${storeLabel} · Current capability decisions`}
    >
      <div className="list-filters" role="search">
        <label>
          Capability
          <select value={key} onChange={(event) => setKey(event.currentTarget.value)}>
            {storeCapabilityChoices.map((choice) => (
              <option value={choice.key} key={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={state.kind === "Loading" || id !== scope.storeReference}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh capability
        </button>
      </div>
      {state.kind === "Found" ? (
        <StatePanel
          heading={
            state.view.reason === "Enabled"
              ? "Capability enabled"
              : state.view.reason === "Disabled"
                ? "Capability disabled"
                : "Capability unavailable"
          }
          tone={state.view.reason === "Enabled" ? "neutral" : "offline"}
          status
        >
          <dl className="detail-list">
            <div>
              <dt>Backend execution</dt>
              <dd>
                {state.view.backendExecution === "Allow" ? "Allowed at observation time" : "Denied"}
              </dd>
            </div>
            <div>
              <dt>Frontend visibility</dt>
              <dd>{state.view.frontendVisibility === "Show" ? "Show" : "Hide"}</dd>
            </div>
            <div>
              <dt>Configuration source</dt>
              <dd>
                {state.view.source === "StoreOverride"
                  ? "Store override"
                  : state.view.source === "BrandOverride"
                    ? "Brand configuration"
                    : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Checked</dt>
              <dd>
                <time dateTime={state.view.observedAt}>{state.view.observedAt}</time>
              </dd>
            </div>
          </dl>
          <p>
            Each action checks current permission and capability again. This observation does not
            authorize a later action.
          </p>
        </StatePanel>
      ) : (
        <StatePanel
          heading={state.kind === "Loading" ? "Loading capability" : "Capability unavailable"}
          tone={state.kind === "Loading" ? "neutral" : "offline"}
          status
        >
          <p>{copy[state.kind]}</p>
        </StatePanel>
      )}
      <StatePanel heading="Configuration and approval">
        <p>
          Enabling or disabling a capability requires a versioned draft, impact review, independent
          approval and current dependencies. No configuration was changed by this check.
        </p>
      </StatePanel>
    </AppFrame>
  );
}
