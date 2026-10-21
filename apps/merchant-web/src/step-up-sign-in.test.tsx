import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import {
  announceStepUpResult,
  openStepUpSignIn,
  parseStepUpMessage,
  parseStepUpResult,
  safeReturnPath,
  STEP_UP_CHANNEL,
  STEP_UP_SIGN_IN_EXPLANATION,
  stepUpResultText,
  stepUpStartPath,
  subscribeStepUpResult,
  type ChannelFactory,
} from "./step-up-sign-in.js";
import { finishStepUp, StepUpCompleteView, stepUpCompleteText } from "./StepUpCompletePage.js";
import { StepUpVerification, stepUpExplanationText } from "./StepUpVerification.js";
import { PIN_ELEVATION_EXPLANATION } from "./StaffPinControls.js";
import {
  KITCHEN_SIGN_IN_HREF,
  SIGN_IN_FAILED_TEXT,
  SIGN_IN_HREF,
  SIGN_IN_UNAVAILABLE_TEXT,
  StaffSignInView,
} from "./StaffSignInPage.js";

/** An in-memory BroadcastChannel: every channel of the same name hears the others. */
function fakeChannels() {
  const open = new Map<string, Set<{ onmessage: ((event: MessageEvent) => void) | null }>>();
  const names: string[] = [];
  const factory: ChannelFactory = (name) => {
    names.push(name);
    const members = open.get(name) ?? new Set();
    open.set(name, members);
    const channel = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage(message: unknown) {
        for (const other of members)
          if (other !== channel) other.onmessage?.({ data: message } as MessageEvent);
      },
      close() {
        members.delete(channel);
      },
    };
    members.add(channel);
    return channel;
  };
  return { factory, names, listeners: (name: string) => open.get(name)?.size ?? 0 };
}

const plain = (html: string) => expect(findInternalText([staticText(html)])).toEqual([]);

describe("WP-2423 DEC-COGNITO-STORE-STAFF confirm it is you by signing in again", () => {
  it("starts the sign-in for the purpose and comes back to the same page only", () => {
    expect(stepUpStartPath("RefundApproval", "/app/approvals?order=A-1")).toBe(
      "/merchant/identity/step-up/start?purpose=RefundApproval&returnTo=%2Fapp%2Fapprovals%3Forder%3DA-1",
    );
    expect(safeReturnPath("/operations/orders")).toBe("/operations/orders");
    for (const unsafe of [
      "//evil.example/x",
      "https://evil.example/",
      "/\\evil.example",
      "javascript:alert(1)",
      "app",
      "",
      null,
      undefined,
    ])
      expect(safeReturnPath(unsafe)).toBe("/app");
  });

  it("opens a small window, or this window where popups are blocked", () => {
    const popup = { open: vi.fn(() => ({})), location: { assign: vi.fn() } };
    expect(openStepUpSignIn("/merchant/identity/step-up/start?x", popup)).toBe("Popup");
    expect(popup.open).toHaveBeenCalledWith(
      "/merchant/identity/step-up/start?x",
      "bop-step-up",
      "popup,width=480,height=720",
    );
    expect(popup.location.assign).not.toHaveBeenCalled();
    const blocked = { open: vi.fn(() => null), location: { assign: vi.fn() } };
    expect(openStepUpSignIn("/merchant/identity/step-up/start?x", blocked)).toBe("SameWindow");
    expect(blocked.location.assign).toHaveBeenCalledWith("/merchant/identity/step-up/start?x");
  });

  it("hears only step-up answers on its own channel, and stops listening", () => {
    const channels = fakeChannels();
    const heard: string[] = [];
    const stop = subscribeStepUpResult((result) => heard.push(result), channels.factory);
    expect(channels.names).toEqual([STEP_UP_CHANNEL]);
    expect(announceStepUpResult("verified", channels.factory)).toBe(true);
    expect(announceStepUpResult("cancelled", channels.factory)).toBe(true);
    expect(heard).toEqual(["verified", "cancelled"]);
    expect(parseStepUpMessage({ type: "other", result: "verified" })).toBeNull();
    expect(parseStepUpMessage({ type: "step-up", result: "done" })).toBeNull();
    stop();
    expect(channels.listeners(STEP_UP_CHANNEL)).toBe(0);
    announceStepUpResult("failed", channels.factory);
    expect(heard).toEqual(["verified", "cancelled"]);
    // No BroadcastChannel: nothing breaks; the page re-reads when its window gets focus.
    expect(subscribeStepUpResult(() => undefined, null)()).toBeUndefined();
    expect(announceStepUpResult("verified", null)).toBe(false);
  });

  it("the sign-in window's last page answers, closes, and otherwise goes back", () => {
    const channels = fakeChannels();
    const heard: string[] = [];
    subscribeStepUpResult((result) => heard.push(result), channels.factory);
    const scheduled: (() => void)[] = [];
    const schedule = (run: () => void) => scheduled.push(run);
    // A popup closes itself.
    const popup = { close: vi.fn(), closed: true, location: { replace: vi.fn() } };
    finishStepUp("verified", "/app/approvals", popup, channels.factory, schedule);
    expect(heard).toEqual(["verified"]);
    expect(popup.close).toHaveBeenCalled();
    scheduled.splice(0).forEach((run) => run());
    expect(popup.location.replace).not.toHaveBeenCalled();
    // The same window (popup blocked) goes back to the page it left.
    const same = { close: vi.fn(), closed: false, location: { replace: vi.fn() } };
    finishStepUp("cancelled", "/app/approvals", same, channels.factory, schedule);
    scheduled.splice(0).forEach((run) => run());
    expect(same.location.replace).toHaveBeenCalledWith("/app/approvals");
    // A failed check stays so its message can be read; no answer for an unknown result.
    const failed = { close: vi.fn(), closed: false, location: { replace: vi.fn() } };
    finishStepUp("failed", "/app", failed, channels.factory, schedule);
    finishStepUp(null, "/app", failed, channels.factory, schedule);
    expect(scheduled).toEqual([]);
    expect(heard).toEqual(["verified", "cancelled", "failed"]);
  });

  it("says how it went in plain words", () => {
    for (const result of ["verified", "cancelled", "failed", "unavailable"] as const) {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <StepUpCompleteView result={result} returnTo="/app/approvals" />
        </MemoryRouter>,
      );
      expect(html).toContain(stepUpCompleteText[result].replace(/'/gu, "&#x27;"));
      expect(html).toContain('href="/app/approvals"');
      plain(html);
    }
    expect(stepUpResultText.cancelled).toBe(
      "You didn't finish signing in. Try again when you're ready.",
    );
    expect(stepUpResultText.failed).toBe(
      "We couldn't confirm it's you. Try again, or ask a manager if it keeps happening.",
    );
    expect(STEP_UP_SIGN_IN_EXPLANATION).toContain("password and authenticator app");
  });

  it("never asks for a six-digit code when the PIN session confirms by signing in again", () => {
    const signIn = stepUpExplanationText("SignIn", PIN_ELEVATION_EXPLANATION);
    expect(signIn).toBe(
      "Confirm it is you by signing in again with your password and authenticator app. After you verify, refunds, price changes and staff changes can go ahead on this PIN sign-in until the time shown.",
    );
    expect(signIn).not.toMatch(/six-digit|code shown/iu);
    // The internal-test authenticator code keeps its own wording.
    expect(stepUpExplanationText("Code", PIN_ELEVATION_EXPLANATION)).toContain(
      "enter the six-digit code shown for this store",
    );
    expect(stepUpExplanationText("SignIn", undefined)).toBe(STEP_UP_SIGN_IN_EXPLANATION);
    expect(stepUpExplanationText("Code", undefined)).toContain("approvals and refunds");
  });

  it("offers the code until the server says to sign in again", () => {
    const html = renderToStaticMarkup(
      <StepUpVerification
        purpose="RefundApproval"
        csrf={"c".repeat(43)}
        verifiedUntil={null}
        onVerified={() => undefined}
        label="Verify to approve"
        fetcher={() => Promise.reject(new Error("not used"))}
        channel={null}
      />,
    );
    expect(html).toContain("Six-digit code");
    expect(html).not.toContain("Continue to sign in");
  });
});

describe("WP-2423 DEC-COGNITO-STORE-STAFF Staff sign-in", () => {
  const render = (failed: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <StaffSignInView failed={failed} />
      </MemoryRouter>,
    );
  it("offers each way in with plain words", () => {
    const html = render(false);
    expect(html).toContain("<h1>Staff sign-in</h1>");
    expect(html).toContain(`href="${SIGN_IN_HREF}"`);
    expect(SIGN_IN_HREF).toBe("/merchant/login?returnTo=/app");
    expect(html).toContain(`href="${KITCHEN_SIGN_IN_HREF}"`);
    expect(KITCHEN_SIGN_IN_HREF).toBe("/merchant/login?returnTo=/operations/kitchen/start");
    expect(html).toContain('href="/operations/switch-staff"');
    expect(html).toContain(
      "Use your work email, your password and the code from your authenticator app.",
    );
    expect(html).toContain(
      "Ask the store owner or manager; they can contact BOP support to reset your sign-in.",
    );
    expect(html).not.toContain('role="alert"');
    plain(html);
  });
  it("explains a refused sign-in above the links", () => {
    const html = render(true);
    expect(html).toContain('role="alert"');
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf(SIGN_IN_HREF));
    expect(html).toContain(SIGN_IN_FAILED_TEXT.replace(/'/gu, "&#x27;"));
    plain(html);
  });
  it("says when signing in is unavailable and who can keep working", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StaffSignInView unavailable />
      </MemoryRouter>,
    );
    expect(html).toContain(SIGN_IN_UNAVAILABLE_TEXT.replace(/'/gu, "&#x27;"));
    expect(html).not.toContain(SIGN_IN_FAILED_TEXT.replace(/'/gu, "&#x27;"));
    expect(SIGN_IN_UNAVAILABLE_TEXT).toContain("already signed in can keep working");
    plain(html);
    expect(parseStepUpResult("unavailable")).toBe("unavailable");
    expect(stepUpResultText.unavailable).toContain("nothing was changed");
  });
});
