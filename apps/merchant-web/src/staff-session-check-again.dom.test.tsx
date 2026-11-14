// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { StaffSessionGuard } from "./StaffSession.js";
import { rememberReturnPage, takeReturnPage, type StaffSessionClient } from "./staff-session.js";
import { setStaffSessionEnded } from "./staff-session-reads.js";
import { click, mount, settle } from "./dom-test-kit.fixture.js";

/**
 * v15 b12 live: after the sign-in ended, the same staff member signed in again in another tab.
 * "Check again" here still sent the ended sign-in's value, was refused (403) and the cover stayed;
 * "Sign in again" brought them back to Orders instead of the page they were on.
 */
afterEach(() => {
  setStaffSessionEnded(false);
  globalThis.sessionStorage.clear();
  document.body.replaceChildren();
});
const old = "a".repeat(43);
const signedOut = (currentSignIn: () => Promise<string | null>) => {
  let checks = 0;
  return {
    activity: vi.fn(async () => "Ended" as const),
    // The routine check says ended; "Check again" with the ended value is refused (403).
    expiry: vi.fn(async () => {
      checks += 1;
      if (checks > 1) throw new Error("STAFF_SESSION_UNAVAILABLE");
      return "Ended" as const;
    }),
    signInEntry: vi.fn(async () => ({ path: "/internal-test/staff", testOnly: true })),
    signOut: vi.fn(async () => undefined),
    currentSignIn: vi.fn(currentSignIn),
  } satisfies StaffSessionClient;
};
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === name);

it("b13: Check again after signing in on another screen opens this page with that sign-in", async () => {
  const client = signedOut(async () => "b".repeat(43));
  const reopenPage = vi.fn();
  const { container } = await mount(
    <StaffSessionGuard
      csrf={old}
      path="/app/commerce/option-recipes"
      timeZone="America/Toronto"
      client={client}
      reopenPage={reopenPage}
    />,
  );
  await settle(10);
  expect(container.textContent).toContain("You’ve been signed out");
  await click(button(container, "Check again"));
  await settle(10);
  expect(client.currentSignIn).toHaveBeenCalled();
  expect(reopenPage).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Signed in again. Opening this page with that sign-in…");
});

it("b13: Check again with no new sign-in stays on the cover and opens nothing", async () => {
  for (const now of [null, old]) {
    const client = signedOut(async () => now);
    const reopenPage = vi.fn();
    const { container, root } = await mount(
      <StaffSessionGuard
        csrf={old}
        path="/app"
        timeZone="America/Toronto"
        client={client}
        reopenPage={reopenPage}
      />,
    );
    await settle(10);
    await click(button(container, "Check again"));
    await settle(10);
    expect(reopenPage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("You’ve been signed out");
    root.unmount();
  }
});

it("b13: Sign in again comes back to the page it was pressed on, once and only soon after", async () => {
  rememberReturnPage("/app/commerce/option-recipes", 1_000);
  expect(takeReturnPage(1_000 + 60_000)).toBe("/app/commerce/option-recipes");
  // Taken once.
  expect(takeReturnPage(1_000 + 60_000)).toBeNull();
  rememberReturnPage("/app/commerce/option-recipes", 1_000);
  expect(takeReturnPage(1_000 + 16 * 60_000)).toBeNull();
  // Never another site or anything that is not a page of this app.
  for (const path of [
    "//evil.example",
    "https://evil.example/app",
    "/app?x=1",
    "/merchant/logout",
  ]) {
    rememberReturnPage(path);
    expect(takeReturnPage()).toBeNull();
  }
  // Signed in again: the screen opens the page it was on.
  rememberReturnPage("/app/commerce/option-recipes");
  const reopenAt = vi.fn();
  const client = {
    ...signedOut(async () => null),
    activity: vi.fn(async () => {
      throw new Error("offline");
    }),
  };
  await mount(
    <StaffSessionGuard
      csrf={old}
      path="/operations/orders"
      timeZone="America/Toronto"
      client={client}
      reopenAt={reopenAt}
    />,
  );
  await settle();
  expect(reopenAt).toHaveBeenCalledWith("/app/commerce/option-recipes");
});
