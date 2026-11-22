// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { DiningSessionCloseAction } from "./DiningSessionCloseAction.js";
import type { DiningProgress } from "./dining-progress-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";

/**
 * Batch 45 (v15 b44 live 2026-11-22 01:33:25 UTC): POST /merchant/dining/closing answered 503
 * "unavailable" for a table visit the store has no record of (a stale page after a store switch)
 * and for a table another device changed at the same moment. It now answers 404 and 409; staff
 * are told in plain words what happened, never "try again" for an outage.
 */
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const view: DiningProgress = {
  orderReference: id(3),
  tableLabel: "T1",
  orderVersion: 3,
  currentOrderVersion: 4,
  chaseDish: false,
  sessionVersion: 4,
  diningSessionReference: id(2),
  sessionPhase: "Closing",
  tableAssignmentVersion: 1,
  closureStatus: "Closed",
  closureVersion: 1,
  phase: "Fulfilled",
  observedAt: "2026-09-20T10:00:00.000Z",
  items: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
  setLanguageForTest("en");
});
async function pressClose(status: number, error: string) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ error }), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const busy: boolean[] = [];
  const { container } = await mount(
    <DiningSessionCloseAction
      view={view}
      csrf={"A".repeat(43)}
      locked={false}
      onBusy={(value) => busy.push(value)}
      onClosed={() => undefined}
    />,
  );
  await click(container.querySelector('input[type="checkbox"]'));
  await click(container.querySelector("button"));
  await settle();
  return { container, fetcher, busy };
}
it.each([
  [
    "en",
    "This table's visit has already ended, or it isn't at this store. Refresh to see the tables as they are now.",
  ],
  ["zh-Hans", "这桌的用餐已经结束，或不在本店。请刷新，查看桌台现在的情况。"],
] as const)("a table visit not at this store is said plainly (%s)", async (language, text) => {
  setLanguageForTest(language);
  const { container, fetcher, busy } = await pressClose(404, "dining_session_not_found");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(text);
  // Not an outage: nothing to send again, and the page is not left busy.
  expect(container.querySelector("button")).toBeNull();
  expect(busy.at(-1)).toBe(false);
  expect(container.textContent).not.toMatch(/dining_session|404|session/iu);
});
it.each([
  ["en", "The table was not closed. Refresh, then check its orders, payments and open problems."],
  ["zh-Hans", null],
] as const)(
  "a table changed at the same moment is said as not closed (%s)",
  async (language, text) => {
    setLanguageForTest(language);
    const { container } = await pressClose(409, "dining_session_changed");
    const said = container.querySelector('[role="status"]')?.textContent ?? "";
    if (text !== null) expect(said).toBe(text);
    else expect(said).toMatch(/[一-鿿]/u);
    expect(said).not.toMatch(/dining_session|409/u);
    expect(buttonNamed(container, /Send it again|再次发送/u)).toBeFalsy();
  },
);
