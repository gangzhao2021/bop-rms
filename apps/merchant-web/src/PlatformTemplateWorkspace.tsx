import { useEffect, useMemo, useRef, useState } from "react";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import {
  createPlatformTemplateClient,
  PlatformTemplateClientError,
  type PlatformTemplateClient,
} from "./platform-template-client.js";
import { PlatformTemplatePanel } from "./PlatformTemplatePanel.js";
import { PlatformTenantListPage } from "./PlatformTenantPages.js";

type Bootstrap = Awaited<ReturnType<PlatformTemplateClient["bootstrap"]>>;
type State =
  | { kind: "Loading" | "Denied" | "Unavailable" | "Offline" | "OutcomeUnknown" }
  | { kind: "Ready"; session: Bootstrap };
export interface PlatformTemplateWorkspaceProps {
  readonly client?: PlatformTemplateClient;
  readonly navigate?: (url: string) => void;
}
const messages = {
  Loading: "Checking your Platform session…",
  Denied: "Sign in with your named Platform account to continue Brand setup.",
  Unavailable: "Platform setup is unavailable. Refresh to check the current session.",
  Offline: "Reconnect before continuing. Any pending original request remains on this device.",
  OutcomeUnknown:
    "The session action could not be confirmed. Refresh your session before continuing.",
} as const;

/** A finite setup prerequisite at the existing Platform return path. It does
 * not supply permission, purpose or support-case access to fleet operations. */
export function PlatformTemplateWorkspace(props: PlatformTemplateWorkspaceProps) {
  const client = useMemo(() => props.client ?? createPlatformTemplateClient(), [props.client]);
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [retry, setRetry] = useState(0);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    busy = useRef(false);
  const owningClient = useRef(client);
  function explain(error: unknown): State {
    if (!navigator.onLine) return { kind: "Offline" };
    if (error instanceof PlatformTemplateClientError && error.code === "Denied")
      return { kind: "Denied" };
    if (error instanceof PlatformTemplateClientError && error.code === "OutcomeUnknown")
      return { kind: "OutcomeUnknown" };
    return { kind: "Unavailable" };
  }
  useEffect(() => {
    const epoch = ++generation.current,
      active = new AbortController();
    controller.current?.abort();
    controller.current = active;
    owningClient.current = client;
    client.invalidate();
    busy.current = false;
    setState({ kind: navigator.onLine ? "Loading" : "Offline" });
    if (navigator.onLine)
      void client
        .bootstrap({ signal: active.signal })
        .then((session) => {
          if (epoch === generation.current && !active.signal.aborted)
            setState({ kind: "Ready", session });
        })
        .catch((error: unknown) => {
          if (epoch === generation.current && !active.signal.aborted) setState(explain(error));
        });
    const offline = () => {
      ++generation.current;
      active.abort();
      client.invalidate();
      busy.current = false;
      setState({ kind: "Offline" });
    };
    window.addEventListener("offline", offline);
    return () => {
      ++generation.current;
      active.abort();
      client.invalidate();
      window.removeEventListener("offline", offline);
    };
  }, [client, retry]);
  useEffect(() => {
    if (state.kind !== "Ready") return;
    const timer = setTimeout(
      () => {
        ++generation.current;
        controller.current?.abort();
        client.invalidate();
        setState({ kind: "Denied" });
      },
      Math.max(0, Date.parse(state.session.session.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [client, state]);
  async function sessionAction(action: "stepUp" | "logout") {
    if (state.kind !== "Ready" || busy.current) return;
    const epoch = ++generation.current,
      active = new AbortController(),
      csrf = state.session.csrf;
    controller.current?.abort();
    controller.current = active;
    client.invalidate();
    busy.current = true;
    setState({ kind: "Loading" });
    try {
      const result =
        action === "stepUp"
          ? await client.stepUp(csrf, { signal: active.signal })
          : await client.logout(csrf, { signal: active.signal });
      if (epoch !== generation.current || active.signal.aborted) return;
      const url = result.status === "step_up_required" ? result.authorizationUrl : result.logoutUrl;
      if (props.navigate) props.navigate(url);
      else window.location.assign(url);
    } catch (error) {
      if (epoch === generation.current && !active.signal.aborted) setState(explain(error));
    } finally {
      if (epoch === generation.current) busy.current = false;
    }
  }
  const current = state.kind === "Ready" && owningClient.current === client ? state.session : null;
  return (
    <AppFrame
      className="bop-shell--platform-template"
      title="Brand setup templates"
      description="Create and publish reusable templates before setting up a Brand."
    >
      <section aria-labelledby="platform-session-title">
        <h2 id="platform-session-title">Platform session</h2>
        {current ? (
          <>
            <p>
              Signed in with a Platform account. Session expires{" "}
              <time dateTime={current.session.expiresAt}>{current.session.expiresAt}</time>.
            </p>
            <div className="card-actions">
              <button type="button" onClick={() => setRetry((n) => n + 1)}>
                Refresh Platform session
              </button>
              <button type="button" onClick={() => void sessionAction("stepUp")}>
                Verify with MFA
              </button>
              <button type="button" onClick={() => void sessionAction("logout")}>
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            <p role="status">{state.kind === "Ready" ? messages.Loading : messages[state.kind]}</p>
            {state.kind === "Denied" ? (
              <a className="shell-action" href="/platform/auth/login">
                Sign in securely
              </a>
            ) : null}
            {state.kind !== "Loading" ? (
              <button type="button" onClick={() => setRetry((n) => n + 1)}>
                Refresh Platform session
              </button>
            ) : null}
          </>
        )}
      </section>
      {current?.recentMfaRequired ? (
        <StatePanel heading="MFA required" status>
          <p>
            Verify with MFA before reading or changing templates. Your pending original request
            stays available after verification.
          </p>
        </StatePanel>
      ) : current ? (
        <PlatformTemplatePanel
          key={`${current.session.actorReference}:${current.session.sessionReference}:${current.csrf}`}
          session={current}
          client={client}
        />
      ) : null}
      <details>
        <summary>Tenant fleet operations</summary>
        <p>
          Tenant browsing and support access require their separate capability, purpose and case.
        </p>
        <PlatformTenantListPage />
      </details>
    </AppFrame>
  );
}
