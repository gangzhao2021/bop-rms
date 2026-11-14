// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { setLanguageForTest } from "./i18n/i18n.js";
import { PageDidNotLoad } from "./PageDidNotLoad.js";
import { StoreOptionRecipesPage } from "./StoreOptionRecipesPage.js";
import { OptionRecipePageError, createOptionRecipeClient } from "./store-option-recipes-page.js";
import { gateStaffSignInFetch, setStaffSessionEnded } from "./staff-session-reads.js";
import { mount, settle } from "./dom-test-kit.fixture.js";

/**
 * v15 b12: the staff session ended while Option recipes was open (pushed out by the
 * concurrent-session limit, or timed out). The page said "The connection may have dropped… Check
 * the Wi-Fi", and Try again sent nothing. A read this screen did not send because its sign-in
 * ended says sign in again; once the sign-in works again the page reads again by itself.
 */
afterEach(() => {
  setStaffSessionEnded(false);
  setLanguageForTest("en");
  document.body.replaceChildren();
});
const wifi = "Check the Wi-Fi";
const signInAgain =
  "Your sign-in on this screen has ended, so this page wasn't read. Sign in again to keep working.";

it("the option recipes client names a read the ended sign-in did not send as SignedOut, a dropped connection as Offline", async () => {
  const gated = gateStaffSignInFetch(
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => "https://pilot.test/app/commerce/option-recipes",
  );
  await expect(createOptionRecipeClient("a".repeat(43), gated).load()).rejects.toMatchObject({
    code: "Offline",
  });
  setStaffSessionEnded(true);
  await expect(createOptionRecipeClient("a".repeat(43), gated).load()).rejects.toMatchObject({
    code: "SignedOut",
  });
});

it("Option recipes says sign in again when its read was refused for an ended sign-in, never check the Wi-Fi", async () => {
  const { container } = await mount(
    <MemoryRouter>
      <StoreOptionRecipesPage
        client={{
          load: async () => {
            throw new OptionRecipePageError("SignedOut");
          },
        }}
      />
    </MemoryRouter>,
  );
  await settle();
  expect(container.textContent).toContain(signInAgain);
  expect(container.textContent).not.toContain(wifi);
});

it("a refused read while the screen is signed out says sign in again, not no access, and reads again once signed in", async () => {
  let reads = 0;
  setStaffSessionEnded(true);
  const { container } = await mount(
    <MemoryRouter>
      <StoreOptionRecipesPage
        client={{
          load: async () => {
            reads += 1;
            throw new OptionRecipePageError("PermissionDenied");
          },
        }}
      />
    </MemoryRouter>,
  );
  await settle();
  expect(container.textContent).toContain(signInAgain);
  expect(container.textContent).not.toContain("permission");
  const before = reads;
  await act(async () => setStaffSessionEnded(false));
  await settle();
  expect(reads).toBe(before + 1);
});

it("any page that did not load says sign in again while the sign-in has ended, in Chinese too", async () => {
  setStaffSessionEnded(true);
  const { container } = await mount(<PageDidNotLoad code="Offline" onRetry={() => undefined} />);
  expect(container.textContent).toContain(signInAgain);
  expect(container.textContent).not.toContain(wifi);
  document.body.replaceChildren();
  setLanguageForTest("zh-Hans");
  const zh = await mount(<PageDidNotLoad code="SignedOut" onRetry={() => undefined} />);
  expect(zh.container.textContent).toContain("这台设备上的登录已结束，所以这个页面没有读取。");
  setStaffSessionEnded(false);
  document.body.replaceChildren();
  setLanguageForTest("en");
  const offline = await mount(<PageDidNotLoad code="Offline" onRetry={() => undefined} />);
  expect(offline.container.textContent).toContain(wifi);
});
