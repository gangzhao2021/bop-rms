import { currentLanguage, t } from "./i18n/i18n.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import type { ReactNode } from "react";
import type { MerchantWorkspaceSnapshot } from "./merchant-workspace.js";
import { StaffSignInLink } from "./StaffSession.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED } from "./full-sign-in.js";
import { businessDateText, useStoreBusinessDay } from "./StoreBusinessDay.js";
import { Freshness } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";

/** The Store's status in Chinese ("Open" alone is also an unresolved follow-up's status there). */
const STORE_STATUS_CHINESE = Object.freeze({
  Open: "营业中",
  Closed: "已打烊",
  Paused: "已暂停",
  Unavailable: "不可用",
} as const);

type MerchantShellState =
  | { readonly kind: "Loading" }
  | { readonly kind: "SignedOut" }
  | { readonly kind: "Offline" }
  | { readonly kind: "Failure" }
  | {
      readonly kind: "Ready";
      readonly switching: boolean;
      /** FullSignInRequired: a PIN sign-in must be confirmed before switching Store. */
      readonly switchFailed: boolean | typeof FULL_SIGN_IN_REQUIRED;
      /** Session token for the "Verify it's you" step. */
      readonly csrf?: string;
      readonly workspace: MerchantWorkspaceSnapshot;
    };

export interface MerchantShellProps {
  readonly state: MerchantShellState;
  readonly onSwitchStore: (targetStoreReference: string) => void | Promise<void>;
  readonly overview?: ReactNode;
  /** WP-2423 P2: the live "right now" card; the release note is shown while it is absent. */
  readonly today?: ReactNode;
  /** WP-2423: a request to the signed-in person shown above the overview (add your name). */
  readonly prompt?: ReactNode;
}

function StateView({ state }: { readonly state: Exclude<MerchantShellState, { kind: "Ready" }> }) {
  const states: Record<
    Exclude<MerchantShellState, { kind: "Ready" }>["kind"],
    readonly [string, string, "neutral" | "error" | "offline"]
  > = {
    Loading: [t("Loading workspace"), t("Checking your session…"), "neutral"],
    SignedOut: [t("Sign in required"), t("Sign in to open your Store workspace."), "neutral"],
    Offline: [t("You’re offline"), t("Reconnect to load your Store workspace."), "offline"],
    Failure: [
      t("Unable to load"),
      t("The workspace is unavailable. No business action was attempted."),
      "error",
    ],
  };
  const details = states[state.kind];
  return (
    <StatePanel heading={details[0]} tone={details[2]} status>
      <p>{details[1]}</p>
      {/* WP-2423 Q18: the sign-in that works here (the labelled test sign-in in the pilot). */}
      {state.kind === "SignedOut" ? <StaffSignInLink /> : null}
    </StatePanel>
  );
}

/** HOME: the Store at a glance. Inside the workspace layout once a session exists. */
export function MerchantShell({
  state,
  onSwitchStore,
  overview = null,
  today,
  prompt = null,
}: MerchantShellProps) {
  const liveBusinessDay = useStoreBusinessDay();
  if (state.kind !== "Ready")
    return (
      <AppFrame title={t("Operations")} description={t("Store workspace")}>
        <StateView state={state} />
      </AppFrame>
    );
  const ready = state;
  const scope = ready.workspace.selectedScope;
  // WP-2423 Q21: the Store's current business day, kept current on a screen left open overnight.
  const businessDate = liveBusinessDay?.businessDate ?? ready.workspace.businessDate;
  const multiStore = ready.workspace.authorizedStores.length > 1;
  return (
    <WorkspacePage
      className="workspace-page--overview"
      title={scope.storeLabel}
      meta={t("{label} · Business date {businessDate}", {
        label: scope.brandLabel,
        businessDate: businessDateText(businessDate),
      })}
      status={<Freshness status={ready.workspace.freshness} />}
      actions={
        multiStore ? (
          <form
            className="scope-switcher"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const target = data.get("store");
              if (typeof target === "string") void onSwitchStore(target);
            }}
          >
            <label htmlFor="store-scope">{t("Authorized Store")}</label>
            <select
              key={scope.storeReference}
              id="store-scope"
              name="store"
              defaultValue={scope.storeReference}
              disabled={ready.switching}
            >
              {ready.workspace.authorizedStores.map((store) => (
                <option key={store.storeReference} value={store.storeReference}>
                  {store.storeLabel} · {store.brandLabel}
                </option>
              ))}
            </select>
            <button type="submit" disabled={ready.switching}>
              {ready.switching ? t("Switching…") : t("Switch Store")}
            </button>
          </form>
        ) : null
      }
    >
      <section id="overview" aria-label={t("Store overview")}>
        {ready.switchFailed === FULL_SIGN_IN_REQUIRED ? (
          <>
            <p role="status">
              {t("Your previous Store is unchanged. After you verify, switch again.")}
            </p>
            <FullSignInPrompt csrf={ready.csrf ?? ""} />
          </>
        ) : ready.switchFailed ? (
          <p className="command-error" role="alert">
            {t("Store switch failed. Your previous Store is unchanged.")}
          </p>
        ) : null}
        {ready.workspace.freshness === "Stale" ? (
          <p className="stale-warning" role="status">
            {t("Stale data · refresh before relying on operational status.")}
          </p>
        ) : null}
        {prompt}
        {overview ?? (
          <div className="overview-grid">
            <section
              className="overview-card overview-card--status"
              aria-labelledby="live-store-status-heading"
            >
              <h3 id="live-store-status-heading">{t("Store status")}</h3>
              <p className="overview-status-value">
                <span>
                  {currentLanguage() === "zh-Hans"
                    ? STORE_STATUS_CHINESE[ready.workspace.storeStatus]
                    : ready.workspace.storeStatus}
                </span>
              </p>
              <p className="overview-status-date">
                {t("Business date {businessDate}", {
                  businessDate: businessDateText(businessDate),
                })}
              </p>
            </section>
            {today ?? (
              <section className="overview-card" aria-labelledby="today-summary-heading">
                <h3 id="today-summary-heading">{t("Today")}</h3>
                <p>
                  {t(
                    "Sales, open orders and exceptions for the day are not available in this release. Use Orders, Kitchen, Pickup and Exceptions from the menu.",
                  )}
                </p>
              </section>
            )}
          </div>
        )}
      </section>
    </WorkspacePage>
  );
}
