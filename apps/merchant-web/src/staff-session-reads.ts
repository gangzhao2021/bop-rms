import { t } from "./i18n/i18n.js";
import { useSyncExternalStore } from "react";

/**
 * v15 cbff9d6f (DEC-STAFF-SESSION-CONTINUITY 2026-10-17 correction): once this screen's sign-in
 * has ended (the signed-out cover is up), nothing on it keeps reading with that sign-in — Orders,
 * Home, alerts, the kitchen and pickup boards, retries and the business-day check all stop instead
 * of collecting refusals every few seconds. They start again on their own if "Check again" finds
 * the sign-in still valid; a new sign-in loads the screen afresh. One value per browser tab.
 */
let ended = false;
const listeners = new Set<() => void>();

/** Called by the session guard when the cover goes up (true) or comes down (false). */
export function setStaffSessionEnded(value: boolean): void {
  if (ended === value) return;
  ended = value;
  for (const listener of [...listeners]) listener();
}

export function staffSessionEnded(): boolean {
  return ended;
}

export function subscribeStaffSessionEnded(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a background read may run: the tab is visible and its sign-in has not ended. */
export function backgroundReadAllowed(
  visible: boolean = typeof document === "undefined" || document.visibilityState === "visible",
): boolean {
  return visible && !ended;
}

/** True while this screen's sign-in is usable; periodic reads stop when it turns false. */
export function useStaffSessionLive(): boolean {
  return !useSyncExternalStore(subscribeStaffSessionEnded, staffSessionEnded, () => false);
}

/**
 * v15 37e0ecbe (DEC-STAFF-SESSION-CONTINUITY 2026-10-17 correction): requests that use this
 * screen's staff sign-in — every same-origin `/merchant/…` call except the sign-in plumbing
 * itself (deadline checks, sign-in entry, sign-out, bootstrap and the shared-tablet PIN screen).
 */
const SIGN_IN_PLUMBING =
  /^\/merchant\/(?:session(?:\/|$)|sign-in-entry$|logout$|staff-switch(?:\/|$))/u;

export function usesStaffSignIn(input: RequestInfo | URL, base: string | undefined): boolean {
  if (base === undefined) return false;
  let url: URL, page: URL;
  try {
    page = new URL(base);
    url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      page,
    );
  } catch {
    return false;
  }
  return (
    url.origin === page.origin &&
    url.pathname.startsWith("/merchant/") &&
    !SIGN_IN_PLUMBING.test(url.pathname)
  );
}

const refusalListeners = new Set<() => void>();

/**
 * A request with this screen's sign-in was refused (401/403). The BFF answers an ended sign-in and a
 * genuine permission denial alike (`403 request_denied`), so this only asks the session guard to
 * check the sign-in at once; the cover goes up only if the deadline read says it has ended.
 */
export function noteSignedInRequestRefused(): void {
  for (const listener of [...refusalListeners]) listener();
}

export function subscribeSignedInRequestRefused(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

let leaving = false;

/**
 * Wraps `fetch` so that no request with this screen's sign-in leaves the tab once the sign-in has
 * ended or the page is being closed or left (whatever starts it: a timer, a retry, a re-render),
 * and so that a refusal of such a request triggers an immediate sign-in check. Requests that do not
 * use the staff sign-in pass through untouched. The refusal is reported as an aborted request,
 * which every screen already treats as "not read".
 */
export function gateStaffSignInFetch(
  original: typeof fetch,
  base: () => string | undefined = () => globalThis.location?.href,
): typeof fetch {
  return (input, init) => {
    if (!usesStaffSignIn(input, base())) return original(input, init);
    if (ended || leaving)
      return Promise.reject(
        new DOMException(t("This screen's sign-in has ended; nothing was sent."), "AbortError"),
      );
    return original(input, init).then((response) => {
      if (response.status === 401 || response.status === 403) noteSignedInRequestRefused();
      return response;
    });
  };
}

let installed = false;

/** Installs the gate on this tab's `fetch` once, before the app renders. */
export function installStaffSignInFetchGate(target: typeof globalThis = globalThis): void {
  if (installed || typeof target.fetch !== "function") return;
  installed = true;
  target.fetch = gateStaffSignInFetch(target.fetch.bind(target), () => target.location?.href);
  // A page being closed or left starts no new signed-in reads; a page restored from the
  // back/forward cache reads again.
  target.addEventListener?.("pagehide", () => {
    leaving = true;
  });
  target.addEventListener?.("pageshow", () => {
    leaving = false;
  });
}

/**
 * Sign-outs in one tab reach the other tabs of this browser at once (they share the sign-in
 * cookie): "Switch staff" or a PIN sign-in in one tab ends the sign-in every other tab is using.
 */
const CHANNEL = "bop-staff-session";
const tab = Math.random().toString(36).slice(2);

export function announceStaffSignInEnded(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ kind: "SignInEnded", from: tab });
    channel.close();
  } catch {
    // No cross-tab channel: each tab still finds out at its next refused read or check.
  }
}

export function subscribeStaffSignInEndedElsewhere(listener: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data as { kind?: unknown; from?: unknown } | null;
    if (data?.kind === "SignInEnded" && data.from !== tab) listener();
  };
  return () => channel.close();
}
