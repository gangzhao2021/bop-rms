import type { StepUpPurpose } from "./refund-approval-client.js";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: a staff member who signs in with their own account confirms it
 * is them by signing in again (password and authenticator app) in a small window. The window ends
 * on `/app/identity/step-up-complete`, which tells the page that opened it how it went over a
 * same-origin BroadcastChannel and closes itself. Without a popup, the same window signs in and
 * comes back to the page it left.
 */
export const STEP_UP_CHANNEL = "bop-staff-step-up";
export const STEP_UP_COMPLETE_PATH = "/app/identity/step-up-complete";
export type StepUpResult = "verified" | "cancelled" | "failed";

export function stepUpStartPath(purpose: StepUpPurpose, returnTo: string): string {
  return (
    "/merchant/identity/step-up/start?purpose=" +
    encodeURIComponent(purpose) +
    "&returnTo=" +
    encodeURIComponent(safeReturnPath(returnTo))
  );
}

/** Only a path on this site ("/…", never "//…" or "/\…"); anything else returns Home. */
export function safeReturnPath(value: string | null | undefined): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    value.length > 2_000 ||
    /[\p{Cc}\\]/u.test(value)
  )
    return "/app";
  try {
    const base = "https://return.invalid";
    const url = new URL(value, base);
    return url.origin === base ? url.pathname + url.search + url.hash : "/app";
  } catch {
    return "/app";
  }
}

export function parseStepUpResult(value: unknown): StepUpResult | null {
  return value === "verified" || value === "cancelled" || value === "failed" ? value : null;
}

/** A channel message `{type:"step-up", result}`, or null for anything else. */
export function parseStepUpMessage(data: unknown): StepUpResult | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const message = data as { type?: unknown; result?: unknown };
  return message.type === "step-up" ? parseStepUpResult(message.result) : null;
}

interface ChannelLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}
export type ChannelFactory = (name: string) => ChannelLike;
const browserChannel = (): ChannelFactory | null =>
  typeof globalThis.BroadcastChannel === "function"
    ? (name) => new globalThis.BroadcastChannel(name)
    : null;

/** Listens for the sign-in window's answer; returns the unsubscribe (a no-op without a channel). */
export function subscribeStepUpResult(
  onResult: (result: StepUpResult) => void,
  factory: ChannelFactory | null = browserChannel(),
): () => void {
  if (factory === null) return () => undefined;
  let channel: ChannelLike;
  try {
    channel = factory(STEP_UP_CHANNEL);
  } catch {
    return () => undefined;
  }
  channel.onmessage = (event) => {
    const result = parseStepUpMessage(event.data);
    if (result !== null) onResult(result);
  };
  return () => {
    channel.onmessage = null;
    channel.close();
  };
}

/** Tells the page that opened the sign-in how it went (false when there is no channel). */
export function announceStepUpResult(
  result: StepUpResult,
  factory: ChannelFactory | null = browserChannel(),
): boolean {
  if (factory === null) return false;
  try {
    const channel = factory(STEP_UP_CHANNEL);
    channel.postMessage({ type: "step-up", result });
    channel.close();
    return true;
  } catch {
    return false;
  }
}

export interface StepUpWindow {
  open(url: string, target: string, features: string): unknown;
  readonly location: { assign(url: string): void };
}
/** Opens the sign-in in a small window; where popups are blocked, this window goes instead. */
export function openStepUpSignIn(url: string, target: StepUpWindow): "Popup" | "SameWindow" {
  let opened: unknown;
  try {
    opened = target.open(url, "bop-step-up", "popup,width=480,height=720");
  } catch {
    opened = null;
  }
  if (opened !== null && opened !== undefined) return "Popup";
  target.location.assign(url);
  return "SameWindow";
}

export const STEP_UP_SIGN_IN_EXPLANATION =
  "Confirm it is you by signing in again with your password and authenticator app. After you verify, approvals and refunds can go ahead for 15 minutes.";
export const stepUpResultText: Record<Exclude<StepUpResult, "verified">, string> = {
  cancelled: "You didn't finish signing in. Try again when you're ready.",
  failed: "We couldn't confirm it's you. Try again, or ask a manager if it keeps happening.",
};
