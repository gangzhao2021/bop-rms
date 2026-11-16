// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { StoreSetupDraftPage } from "./StoreSetupDraftPage.js";
import { createStoreSetupClient, type StoreSetupSnapshot } from "./store-setup-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { buttonNamed, click, deferred, mount, settle, typeInto } from "./dom-test-kit.fixture.js";

/**
 * b23 (v15 live check of b22, store-setup-reconnect): losing the connection on Store setup says the
 * page is offline, not that the settings could not be loaded; once the connection is back the page
 * reads the current settings again by itself, keeps what was typed and drops the offline message.
 */
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-11-16T10:00:00.000Z";
const csrf = "A".repeat(43);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const notLoaded =
  "The current Store settings could not be loaded. Connect and refresh to try again.";
const offlineText =
  "Offline. What you typed here is kept. The current Store settings are read again when the connection is back.";
// No draft saved yet: the steps start from nothing.
const saved: StoreSetupSnapshot | null = null;
const body = () => ({
  profile: "StoreSetupWorkspaceV1",
  scope,
  store: {
    storeReference: id(3),
    code: "SYNTH",
    displayName: "Synthetic store",
    locale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    version: 1,
  },
  setup: {
    profile: "StoreSetupCurrentV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    readerActorReference: id(4),
    snapshot: saved,
    observedAt: new Date(Date.now()).toISOString(),
    validUntil: new Date(Date.now() + 5000).toISOString(),
    businessReferenceValidation: "NotEvaluated",
  },
});
const ok = () =>
  new Response(JSON.stringify(body()), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
let onLine = true;
beforeEach(() => {
  onLine = true;
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => onLine);
});
afterEach(() => {
  setLanguageForTest("en");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function connection(value: boolean) {
  onLine = value;
  await act(async () => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
  await settle(10);
}
async function page(reads: (signal: AbortSignal | null | undefined) => Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => reads(init?.signal));
  const { container } = await mount(
    <MemoryRouter initialEntries={[`/app/organization/stores/${id(3)}/setup`]}>
      <Routes>
        <Route
          path="/app/organization/stores/:id/setup"
          element={
            <StoreSetupDraftPage
              storeReference={id(3)}
              csrf={csrf}
              client={createStoreSetupClient(fetcher)}
              journalFactory={() => ({
                load: async () => null,
                reserve: vi.fn(),
                complete: vi.fn(),
              })}
              // The opening list is not read here: the page shows an open Store's steps.
              fetcher={vi.fn(async () => new Response("{}", { status: 503 }))}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await settle(10);
  return { container, fetcher };
}
const alerts = (container: HTMLElement) =>
  [...container.querySelectorAll("[role=alert]")].map((node) => node.textContent);
const startField = (container: HTMLElement) =>
  [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("Business day starts at (local time)"))
    ?.querySelector("input") as HTMLInputElement | null;

it("b23: offline says offline; back online the page reads again by itself and keeps what was typed", async () => {
  const { container, fetcher } = await page(async () => ok());
  expect(fetcher).toHaveBeenCalledTimes(1);
  await click(buttonNamed(container, "1. Time zone and business day"));
  await typeInto(startField(container), "05:00");
  expect(startField(container)?.value).toBe("05:00");
  await connection(false);
  expect(alerts(container)).not.toContain(notLoaded);
  expect(container.textContent).toContain(offlineText);
  expect(buttonNamed(container, "Save as draft")?.hasAttribute("disabled")).toBe(true);
  await connection(true);
  // Read again once, without a refresh by hand, and the offline line is gone.
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(alerts(container)).not.toContain(notLoaded);
  expect(container.textContent).not.toContain(offlineText);
  expect(container.textContent).not.toContain(notLoaded);
  // The edit not saved yet is still there, and the page can save it.
  expect(startField(container)?.value).toBe("05:00");
  expect(buttonNamed(container, "Save as draft")?.hasAttribute("disabled")).toBe(false);
});

it("b23: the connection dropping during the first read loads the page once it is back", async () => {
  const first = deferred<Response>();
  let reads = 0;
  const { container, fetcher } = await page(async (signal) => {
    reads++;
    if (reads > 1) return ok();
    signal?.addEventListener("abort", () => first.reject(new DOMException("gone", "AbortError")));
    return first.promise;
  });
  expect(buttonNamed(container, "Save as draft")).toBeUndefined();
  await connection(false);
  expect(alerts(container)).not.toContain(notLoaded);
  expect(container.textContent).toContain(offlineText);
  await connection(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(alerts(container)).not.toContain(notLoaded);
  expect(buttonNamed(container, "Save as draft")?.hasAttribute("disabled")).toBe(false);
});

it("b23: a page opened offline loads once the connection is back", async () => {
  onLine = false;
  const { container, fetcher } = await page(async () => ok());
  expect(fetcher).not.toHaveBeenCalled();
  expect(alerts(container)).not.toContain(notLoaded);
  expect(container.textContent).toContain(offlineText);
  await connection(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(buttonNamed(container, "Save as draft")?.hasAttribute("disabled")).toBe(false);
});

it("b23: a read that fails while online still says it could not be loaded", async () => {
  const { container } = await page(async () => new Response("{}", { status: 503 }));
  expect(alerts(container)).toContain(notLoaded);
  expect(container.textContent).not.toContain(offlineText);
});

it("b23: the offline line reads in Chinese", async () => {
  setLanguageForTest("zh-Hans");
  onLine = false;
  const { container } = await page(async () => ok());
  expect(container.textContent).toContain(
    "已离线。你在这里输入的内容会保留，网络恢复后会自动重新读取当前门店设置。",
  );
  expect(container.textContent).not.toContain("无法加载当前门店设置");
});
