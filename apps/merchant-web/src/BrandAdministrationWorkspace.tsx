import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import {
  createMerchantBrandWorkspaceClient,
  MerchantBrandWorkspaceError,
  type MerchantBrandBootstrap,
  parseMerchantBrandSessionUrl,
  type MerchantBrandWorkspaceClient,
} from "./merchant-brand-workspace.js";
import { BrandStoreTopologyDraftPanel } from "./BrandStoreTopologyDraftPanel.js";
import { BrandConfigurationPanel } from "./BrandConfigurationPanel.js";
import { BrandLifecyclePanel } from "./BrandLifecyclePanel.js";
import { BrandCatalogSourcePanel } from "./BrandCatalogSourcePanel.js";

type State =
  | {
      readonly kind:
        | "Loading"
        | "AccessRequired"
        | "Unavailable"
        | "Offline"
        | "NotFound"
        | "ScopeChanged"
        | "OutcomeUnknown";
    }
  | { readonly kind: "MfaRequired" | "LogoutPending"; readonly csrf: string }
  | {
      readonly kind: "Ready";
      readonly value: Extract<MerchantBrandBootstrap, { recentMfaRequired: false }>;
    };
export interface BrandAdministrationWorkspaceProps {
  readonly client?: MerchantBrandWorkspaceClient;
  readonly topologyCsrf?: string;
  readonly topologyStoreReference?: string;
}
const validBrand = (value: string | undefined): value is string =>
  value !== undefined &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const messages = {
  Loading: ["Loading Brand administration", "Checking your current Brand access…"],
  AccessRequired: [
    "Brand access required",
    "Sign in with an account authorized to manage this Brand.",
  ],
  Unavailable: [
    "Brand administration unavailable",
    "Brand access could not be confirmed. Retry to load current access.",
  ],
  Offline: [
    "Offline read-only",
    "Reconnect and refresh access before continuing. Pending requests remain available for recovery.",
  ],
  NotFound: ["Brand not found", "This Brand address is unavailable."],
  ScopeChanged: [
    "Brand access changed",
    "The current Brand or account changed. Refresh access before continuing.",
  ],
  OutcomeUnknown: [
    "Session result unknown",
    "Refresh access to determine the current session before continuing.",
  ],
} as const;

export function BrandAdministrationView({
  state,
  onRefresh,
  onRotate,
  onLogout,
  topologyCsrf,
  topologyStoreReference,
}: {
  readonly state: State;
  readonly onRefresh: () => void;
  readonly onRotate: () => void;
  readonly onLogout: () => void;
  readonly topologyCsrf?: string;
  readonly topologyStoreReference?: string;
}) {
  const current = state.kind === "Ready" ? state.value : null;

  return (
    <AppFrame
      className="bop-shell--brand-administration"
      title={current?.workspace.brand.label ?? "Brand administration"}
      description="Brand configuration and catalog source"
      navigation={
        current
          ? current.workspace.navigation.map((item) => (
              <a key={item.screenId} href={item.href} aria-current="page">
                {item.label}
              </a>
            ))
          : undefined
      }
    >
      {state.kind === "MfaRequired" || state.kind === "LogoutPending" ? (
        <StatePanel
          heading={
            state.kind === "MfaRequired" ? "Verify your identity" : "Sign-out result unknown"
          }
          status
        >
          <p>
            {state.kind === "MfaRequired"
              ? "Verify with a fresh sign-in and TOTP challenge before managing this Brand."
              : "Business access is hidden. Retry sign-out with this session; its local access may already be revoked."}
          </p>
          {state.kind === "MfaRequired" ? (
            <button type="button" onClick={onRotate}>
              Verify identity
            </button>
          ) : null}
          <button type="button" onClick={onLogout}>
            {state.kind === "LogoutPending" ? "Retry sign out" : "Sign out"}
          </button>
        </StatePanel>
      ) : state.kind !== "Ready" ? (
        <StatePanel
          heading={messages[state.kind][0]}
          tone={state.kind === "Offline" ? "offline" : "neutral"}
          status
        >
          <p>{messages[state.kind][1]}</p>
          {state.kind === "AccessRequired" ? (
            <a className="shell-action" href="/merchant/organization/brands/login">
              Sign in securely
            </a>
          ) : null}
          {state.kind !== "Loading" && state.kind !== "NotFound" ? (
            <button type="button" onClick={onRefresh}>
              Refresh Brand access
            </button>
          ) : null}
        </StatePanel>
      ) : state.value.workspace.navigation.length === 0 ? (
        <StatePanel heading="Brand administration disabled" status>
          <p>This session has no available Brand administration entry.</p>
          <button type="button" onClick={onRefresh}>
            Refresh Brand access
          </button>
        </StatePanel>
      ) : (
        <>
          <section aria-label="Brand session">
            <p>Brand status: {state.value.workspace.brand.lifecycle}</p>
            <button type="button" onClick={onRefresh}>
              Refresh Brand access
            </button>{" "}
            <button type="button" onClick={onRotate}>
              Renew session
            </button>{" "}
            <button type="button" onClick={onLogout}>
              Sign out
            </button>
          </section>
          <BrandLifecyclePanel
            scope={state.value.workspace.selectedScope}
            csrf={state.value.csrf}
            brand={state.value.workspace.brand}
            onRefresh={onRefresh}
          />
          <BrandCatalogSourcePanel
            scope={state.value.workspace.selectedScope}
            csrf={state.value.csrf}
          />
          <BrandConfigurationPanel
            scope={state.value.workspace.selectedScope}
            csrf={state.value.csrf}
            brandVersion={state.value.workspace.brand.version}
          />
          {topologyCsrf && topologyStoreReference ? (
            <BrandStoreTopologyDraftPanel
              key={topologyStoreReference + topologyCsrf}
              expectedBrandReference={state.value.workspace.selectedScope.brandReference}
              csrf={topologyCsrf}
            />
          ) : (
            <section aria-labelledby="brand-store-assignments-heading">
              <h2 id="brand-store-assignments-heading">Store assignments</h2>
              <p>Store assignment management requires an authorized Store workspace.</p>
              <a href="/app">Open Store workspace</a>
            </section>
          )}
        </>
      )}
    </AppFrame>
  );
}

/** Brand authorization has its own bootstrap; a Store selection never grants it. */
export function BrandAdministrationWorkspace(props: BrandAdministrationWorkspaceProps) {
  const { id } = useParams(),
    client = useMemo(() => props.client ?? createMerchantBrandWorkspaceClient(), [props.client]);
  const [state, setState] = useState<State>({ kind: "Loading" }),
    [retry, setRetry] = useState(0);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    busy = useRef(false),
    owningClient = useRef(client),
    logoutRecovery = useRef<{ csrf: string } | null>(null);
  const errorState = (error: unknown): State => {
    if (!navigator.onLine) return { kind: "Offline" };
    if (error instanceof MerchantBrandWorkspaceError && error.code !== "Invalid")
      return { kind: error.code };
    return { kind: "Unavailable" };
  };
  useEffect(() => {
    const epoch = ++generation.current,
      c = new AbortController();
    owningClient.current = client;
    logoutRecovery.current = null;
    controller.current?.abort();
    controller.current = c;
    client.invalidate();
    busy.current = false;
    setState({ kind: validBrand(id) ? "Loading" : "NotFound" });
    if (!validBrand(id))
      return () => {
        c.abort();
        client.invalidate();
      };
    if (!navigator.onLine) setState({ kind: "Offline" });
    else
      void client
        .bootstrap(id, { signal: c.signal })
        .then((value) => {
          if (generation.current === epoch && !c.signal.aborted)
            setState(
              value.recentMfaRequired
                ? { kind: "MfaRequired", csrf: value.csrf }
                : { kind: "Ready", value },
            );
        })
        .catch((error: unknown) => {
          if (generation.current === epoch && !c.signal.aborted) setState(errorState(error));
        });
    const offline = () => {
      ++generation.current;
      c.abort();
      client.invalidate();
      busy.current = false;
      setState(
        logoutRecovery.current
          ? { kind: "LogoutPending", csrf: logoutRecovery.current.csrf }
          : { kind: "Offline" },
      );
    };
    window.addEventListener("offline", offline);
    return () => {
      ++generation.current;
      c.abort();
      client.invalidate();
      window.removeEventListener("offline", offline);
    };
  }, [client, id, retry]);
  async function sessionAction(action: "rotate" | "logout") {
    if (
      (state.kind !== "Ready" && state.kind !== "MfaRequired" && state.kind !== "LogoutPending") ||
      busy.current ||
      !validBrand(id)
    )
      return;
    if (action === "rotate" && state.kind === "LogoutPending") return;
    const current = { csrf: state.kind === "Ready" ? state.value.csrf : state.csrf },
      epoch = ++generation.current,
      c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    client.invalidate();
    busy.current = true;
    if (action === "logout") logoutRecovery.current = current;
    setState({ kind: "Loading" });
    try {
      if (action === "logout") {
        const result = await client.logout(current, { signal: c.signal });
        if (generation.current === epoch && !c.signal.aborted) {
          setState({ kind: "LogoutPending", csrf: current.csrf });
          if (result.status === "browser_logout_required")
            window.location.assign(parseMerchantBrandSessionUrl(result.logoutUrl));
        }
      } else {
        const result = await client.rotate(current, { signal: c.signal });
        if (generation.current === epoch && !c.signal.aborted) {
          setState({ kind: "MfaRequired", csrf: current.csrf });
          window.location.assign(parseMerchantBrandSessionUrl(result.authorizationUrl));
        }
      }
    } catch {
      if (generation.current === epoch && !c.signal.aborted)
        setState(
          action === "logout"
            ? { kind: "LogoutPending", csrf: current.csrf }
            : { kind: "MfaRequired", csrf: current.csrf },
        );
    } finally {
      if (generation.current === epoch) busy.current = false;
    }
  }
  const visible = !validBrand(id)
    ? { kind: "NotFound" as const }
    : state.kind === "Ready" &&
        (state.value.workspace.selectedScope.brandReference !== id ||
          owningClient.current !== client)
      ? { kind: "Loading" as const }
      : state;
  return (
    <BrandAdministrationView
      state={visible}
      onRefresh={() => {
        if (logoutRecovery.current || state.kind === "MfaRequired") return;
        ++generation.current;
        controller.current?.abort();
        client.invalidate();
        setState({ kind: "Loading" });
        setRetry((n) => n + 1);
      }}
      onRotate={() => void sessionAction("rotate")}
      onLogout={() => void sessionAction("logout")}
      {...(props.topologyCsrf === undefined ? {} : { topologyCsrf: props.topologyCsrf })}
      {...(props.topologyStoreReference === undefined
        ? {}
        : { topologyStoreReference: props.topologyStoreReference })}
    />
  );
}
