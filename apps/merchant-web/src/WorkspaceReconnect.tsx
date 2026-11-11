import { t } from "./i18n/i18n.js";
import { createContext, useContext, type ReactNode } from "react";
import { WorkspacePage } from "./WorkspacePage.js";
import { StoreTimeZoneContext, storeTime } from "./StoreTime.js";
import type { MerchantNavigationItem } from "./merchant-workspace.js";

/**
 * WP-2423 M01 (bundle merchant-outage-recovery): while the workspace answer cannot be read (the
 * system is busy or down, or this device is offline) every session-gated page shows that it is
 * reconnecting by itself, never the "session and Store are required" dead end. Only a real
 * sign-out reaches those texts.
 *
 * - Reconnecting: the system did not answer (a 503, a timeout, the maintenance page). Retried.
 * - Offline: the browser reports no network. Retried at once when it is back.
 * - Broken: the answer arrived but could not be read (`MERCHANT_WORKSPACE_INVALID`). Retrying
 *   would read the same answer again, so it is final until the page is reloaded.
 */
export type WorkspaceGate = "Reconnecting" | "Offline" | "Broken";

export interface WorkspaceReconnect {
  readonly gate: WorkspaceGate;
  /** When this tab last asked (UTC instant), shown so staff see it keeps trying. */
  readonly lastTriedAt: string | null;
  readonly retry: () => void;
}

export const WorkspaceReconnectContext = createContext<WorkspaceReconnect | null>(null);

export function useWorkspaceReconnect(): WorkspaceReconnect | null {
  return useContext(WorkspaceReconnectContext);
}

/**
 * What staff see in place of a page while the workspace answer cannot be read. Live v15 2026-11-10:
 * it is a page of its own (title row with the language switch, the page's margins, a real button),
 * not a bare panel under the switch and against the sidebar.
 */
export function WorkspaceReconnectPanel({ reconnect }: { readonly reconnect: WorkspaceReconnect }) {
  // Before the first answer this tab may not know the Store's zone: the device's own clock then.
  const timeZone =
    useContext(StoreTimeZoneContext) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (reconnect.gate === "Broken")
    return (
      <WorkspacePage title={t("This page can't be opened")} className="workspace-reconnect">
        <div className="workspace-reconnect__body" role="status" data-reconnect="Broken">
          <p>
            {t(
              "The system's answer could not be read. Reload the page; if it happens again, keep serving with paper slips and tell the store's owner.",
            )}
          </p>
        </div>
      </WorkspacePage>
    );
  const offline = reconnect.gate === "Offline";
  return (
    <WorkspacePage
      title={offline ? t("This device is offline") : t("Can't connect right now")}
      className="workspace-reconnect"
    >
      <div className="workspace-reconnect__body" role="status" data-reconnect={reconnect.gate}>
        <p>
          {offline
            ? t("Check the wifi. The page opens again by itself when the network is back.")
            : t(
                "Retrying on its own. This page opens as soon as the system answers. Orders already sent stay in the system. Keep serving with paper slips if it takes more than a few minutes.",
              )}
        </p>
        {/* AGENTS.md "Warn before timeouts": the refund countdown cannot be read from here. */}
        <p>
          {t(
            "Paid orders that nobody accepts in time may be refunded automatically, and this screen can't warn you while it is reconnecting. Check new orders on a screen that is still connected; if none is, follow the paper-slip steps in the store runbook.",
          )}
        </p>
        <div className="workspace-reconnect__retry">
          <button type="button" className="shell-action" onClick={reconnect.retry}>
            {t("Try now")}
          </button>
          {reconnect.lastTriedAt === null ? null : (
            <p>{t("Last tried {time}", { time: storeTime(reconnect.lastTriedAt, timeZone) })}</p>
          )}
        </div>
      </div>
    </WorkspacePage>
  );
}

/** A session-gated page: the reconnect panel while the workspace cannot be read, else the page. */
export function ReconnectGate({ children }: { readonly children: ReactNode }) {
  const reconnect = useWorkspaceReconnect();
  return reconnect === null ? <>{children}</> : <WorkspaceReconnectPanel reconnect={reconnect} />;
}

/**
 * The page frame kept for this tab while reconnecting (sessionStorage, per tab). It holds the
 * navigation labels and addresses and the Store's name only: items whose address carries a Store or
 * Brand reference are left out, and nothing about the person, the session or its token is kept.
 */
export const WORKSPACE_FRAME_KEY = "bop.workspace.frame.v1";

export interface WorkspaceFrame {
  readonly storeLabel: string;
  /** The Store's IANA time zone, so times while reconnecting read in store time. */
  readonly timeZone?: string | undefined;
  readonly navigation: readonly MerchantNavigationItem[];
}

const REFERENCE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

export function workspaceFrameToStore(frame: WorkspaceFrame): WorkspaceFrame {
  return {
    storeLabel: frame.storeLabel,
    ...(frame.timeZone === undefined ? {} : { timeZone: frame.timeZone }),
    navigation: frame.navigation
      .filter((item) => !REFERENCE.test(item.href))
      .map((item) => ({
        screenId: item.screenId,
        label: item.label,
        href: item.href,
        permission: item.permission,
      })),
  };
}

export function saveWorkspaceFrame(frame: WorkspaceFrame): void {
  try {
    globalThis.sessionStorage?.setItem(
      WORKSPACE_FRAME_KEY,
      JSON.stringify(workspaceFrameToStore(frame)),
    );
  } catch {
    // Storage blocked: a reconnecting page then shows without its navigation.
  }
}

export function clearWorkspaceFrame(): void {
  try {
    globalThis.sessionStorage?.removeItem(WORKSPACE_FRAME_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

export function loadWorkspaceFrame(): WorkspaceFrame | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(WORKSPACE_FRAME_KEY);
    if (raw === null || raw === undefined) return null;
    const value = JSON.parse(raw) as Partial<WorkspaceFrame> | null;
    if (
      value === null ||
      typeof value.storeLabel !== "string" ||
      !Array.isArray(value.navigation) ||
      !value.navigation.every(
        (item: Partial<MerchantNavigationItem> | null) =>
          item !== null &&
          typeof item.screenId === "string" &&
          typeof item.label === "string" &&
          typeof item.href === "string" &&
          item.href.startsWith("/") &&
          !REFERENCE.test(item.href),
      )
    )
      return null;
    return {
      storeLabel: value.storeLabel,
      ...(typeof value.timeZone === "string" ? { timeZone: value.timeZone } : {}),
      navigation: value.navigation,
    };
  } catch {
    return null;
  }
}
