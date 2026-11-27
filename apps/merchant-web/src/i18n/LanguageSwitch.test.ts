import { afterEach, expect, it, vi } from "vitest";
import { systemAnswersForReload } from "./LanguageSwitch.js";
import { zhHans } from "./zh-Hans.js";

/**
 * WP-2423 batch 55 (v15 batch 54 live, kitchen display offline): the language switch reloads the
 * page only when the store system answers; otherwise the reload would lose the screen to the
 * offline page. The browser can say "online" while the internet is down.
 */
afterEach(() => vi.unstubAllGlobals());

const answering = (answer: () => Promise<Response>) => vi.fn(answer) as unknown as typeof fetch;

it("lets the switch reload when the store system answers", async () => {
  const ask = answering(async () => new Response("", { status: 200 }));
  expect(await systemAnswersForReload(ask)).toBe(true);
  expect(ask).toHaveBeenCalledWith(
    "/operations/sw.js",
    expect.objectContaining({ cache: "no-store" }),
  );
});

it("refuses while nothing answers (Wi-Fi up, internet down)", async () => {
  expect(
    await systemAnswersForReload(answering(() => Promise.reject(new TypeError("Failed to fetch")))),
  ).toBe(false);
});

it("refuses while the store system is down (503): the reload would show the outage page", async () => {
  expect(
    await systemAnswersForReload(answering(async () => new Response("", { status: 503 }))),
  ).toBe(false);
});

it("refuses without asking while the device is offline", async () => {
  vi.stubGlobal("navigator", { onLine: false });
  const ask = answering(async () => new Response("", { status: 200 }));
  expect(await systemAnswersForReload(ask)).toBe(false);
  expect(ask).not.toHaveBeenCalled();
});

it("says why in Chinese too", () => {
  expect(
    zhHans[
      "Can't reach the system right now, so the language can't change. This screen stays as it is; try again once connected."
    ],
  ).toBe("现在连不上系统，语言暂时换不了。这一页保持不变，联网后再试。");
});
