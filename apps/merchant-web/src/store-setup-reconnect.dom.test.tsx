// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { StoreSetupDraftPage } from "./StoreSetupDraftPage.js";
import {
  createStoreSetupClient,
  createUnconfiguredStoreSetupContentV2,
  type StoreSetupCursor,
  type StoreSetupSnapshot,
} from "./store-setup-client.js";
import type { StoreSetupPendingJournal } from "./store-setup-pending-journal.js";
import { publicationValueDigest } from "./product-publication-command-client-v2.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import {
  buttonNamed,
  click,
  deferred,
  mount,
  selectValue,
  settle,
  typeInto,
} from "./dom-test-kit.fixture.js";

// The live configuration read (the start the open Store runs on): held until it is cut off.
const liveReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("./store-configuration-pending-journal.js", async (original) => ({
  ...(await original<typeof import("./store-configuration-pending-journal.js")>()),
  createStoreConfigurationPendingJournal: () => ({ load: async () => null }),
}));
vi.mock("./store-configuration-ordinary-client.js", async (original) => {
  const actual = await original<typeof import("./store-configuration-ordinary-client.js")>();
  return {
    ...actual,
    createStoreConfigurationOrdinaryClient: (...args: unknown[]) => ({
      ...actual.createStoreConfigurationOrdinaryClient(...(args as [])),
      load: (_scope: unknown, options?: { signal?: AbortSignal }) => {
        liveReads.count++;
        return new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("gone", "AbortError")),
          ),
        );
      },
    }),
  };
});

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

/**
 * b23 review: a server holding a saved draft, and this device's record of a save waiting for its
 * result, so reconnect can meet a draft saved elsewhere, a save whose answer was lost, or a newer
 * draft to show.
 */
const conflictText =
  "The saved settings or their baseline changed. Refresh, then discard your local edits to use the latest saved version.";
const invalidText = "Check the edited settings.";
const savedText = "Setup draft saved. These settings have not been validated or published.";
const recoveryText = "An earlier save has not been cleared. A new save is blocked.";
function snapshot(revision: number, start: string): StoreSetupSnapshot {
  return {
    profile: "StoreSetupDraftV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    setupDraftReference: id(6),
    revision,
    authoredByReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    baseConfigurationReference: null,
    content: {
      ...createUnconfiguredStoreSetupContentV2(),
      businessDayStartLocalTime: { state: "Configured", value: start },
    } as StoreSetupSnapshot["content"],
    createdAt: at,
    updatedAt: at,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
  };
}
function server(first: StoreSetupSnapshot | null) {
  const state = {
    saved: first,
    cursor: null as StoreSetupCursor | null,
    receipt: null as unknown,
    // While set, the answer to a save is held until the connection drops (the save still lands).
    holdSaves: false,
    // A held save the server never received: the original is found not to have gone through.
    dropHeld: false,
  };
  const workspaceBody = () => ({
    ...body(),
    setup: { ...body().setup, snapshot: state.saved },
  });
  const commands: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") {
      commands.push("read");
      return new Response(JSON.stringify(workspaceBody()), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    commands.push(String(sent.command));
    if (sent.command === "ResolveOriginal")
      return new Response(JSON.stringify(state.receipt), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    const content = sent.content as StoreSetupSnapshot["content"];
    const before = state.saved;
    state.saved = {
      ...snapshot(Number(sent.expectedRevision) + 1, "04:00:00"),
      content,
    };
    state.receipt = {
      profile: "StoreSetupOperationReceiptV1",
      ...scope,
      operationReference: sent.operationReference,
      expectedSetupReference: sent.expectedSetupReference,
      expectedRevision: sent.expectedRevision,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest: await publicationValueDigest({
        profile: "StoreSetupSaveV2",
        ...scope,
        operationReference: sent.operationReference,
        expectedSetupReference: sent.expectedSetupReference,
        expectedRevision: sent.expectedRevision,
        content,
        purposeCode: "STORE_SETUP_DRAFT",
      }),
      outcome: "Committed",
      snapshot: state.saved,
      auditReference: id(7),
      occurredAt: at,
    };
    if (state.dropHeld)
      state.receipt = {
        ...(state.receipt as Record<string, unknown>),
        outcome: "Abandoned",
        snapshot: null,
      };
    if (state.dropHeld) state.saved = before;
    if (state.holdSaves) {
      const signal = init.signal;
      return new Promise<Response>((_, reject) =>
        signal?.addEventListener("abort", () => reject(new DOMException("gone", "AbortError"))),
      );
    }
    return new Response(JSON.stringify(state.receipt), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  });
  const journal: StoreSetupPendingJournal = {
    load: async () => state.cursor,
    reserve: vi.fn(async (cursor: StoreSetupCursor) => {
      state.cursor = cursor;
    }),
    complete: vi.fn(async () => {
      state.cursor = null;
    }),
  };
  return { state, fetcher, journal, commands };
}
async function serverPage(s: ReturnType<typeof server>) {
  const { container } = await mount(
    <MemoryRouter initialEntries={[`/app/organization/stores/${id(3)}/setup`]}>
      <Routes>
        <Route
          path="/app/organization/stores/:id/setup"
          element={
            <StoreSetupDraftPage
              storeReference={id(3)}
              csrf={csrf}
              client={createStoreSetupClient(s.fetcher)}
              journalFactory={() => s.journal}
              fetcher={vi.fn(async () => new Response("{}", { status: 503 }))}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await settle(10);
  return container;
}

it("b23 review: a draft saved elsewhere while offline is a Conflict on reconnect, and the edit stays", async () => {
  const s = server(snapshot(1, "04:00:00"));
  const container = await serverPage(s);
  await click(buttonNamed(container, "1. Time zone and business day"));
  await typeInto(startField(container), "05:00");
  await connection(false);
  s.state.saved = snapshot(2, "06:00:00");
  await connection(true);
  expect(alerts(container)).toContain(conflictText);
  expect(startField(container)?.value).toBe("05:00");
});

it("b23 review: a save whose answer was lost offline is settled on reconnect, with no Conflict", async () => {
  const s = server(snapshot(1, "04:00:00"));
  const container = await serverPage(s);
  await click(buttonNamed(container, "1. Time zone and business day"));
  await typeInto(startField(container), "05:00");
  s.state.holdSaves = true;
  await click(buttonNamed(container, "Save as draft"));
  await settle(20);
  expect(s.state.cursor).not.toBeNull();
  // The server committed it; the answer is lost with the connection.
  await connection(false);
  expect(container.textContent).toContain(recoveryText);
  s.state.holdSaves = false;
  await connection(true);
  await settle(20);
  expect(s.commands).toContain("ResolveOriginal");
  expect(alerts(container)).not.toContain(conflictText);
  expect(container.textContent).not.toContain(recoveryText);
  expect(container.textContent).toContain(
    "The original save was committed. Current saved settings are shown.",
  );
  expect(s.state.cursor).toBeNull();
  expect(startField(container)?.value).toBe("05:00");
  expect(buttonNamed(container, "Save as draft")?.hasAttribute("disabled")).toBe(false);
});

it("b23 review: with nothing typed, reconnect shows a newer draft saved elsewhere", async () => {
  const s = server(snapshot(1, "04:00:00"));
  const container = await serverPage(s);
  await click(buttonNamed(container, "1. Time zone and business day"));
  expect(startField(container)?.value).toBe("04:00");
  await connection(false);
  s.state.saved = snapshot(2, "06:00:00");
  await connection(true);
  expect(alerts(container)).not.toContain(conflictText);
  expect(startField(container)?.value).toBe("06:00");
});

it("b23 review: reconnect keeps a save notice and a validation message that are still true", async () => {
  const s = server(snapshot(1, "04:00:00"));
  const container = await serverPage(s);
  await click(buttonNamed(container, "1. Time zone and business day"));
  await typeInto(startField(container), "04:00");
  await click(buttonNamed(container, "Save as draft"));
  await settle(20);
  expect(container.textContent).toContain(savedText);
  await connection(false);
  await connection(true);
  expect(s.commands.filter((c) => c === "read").length).toBeGreaterThan(2);
  expect(container.textContent).toContain(savedText);
  // A tip turned on without its orders cannot be saved; that stays said while it is still so.
  await click(buttonNamed(container, "3. Fees, tax and payment"));
  await selectValue(container.querySelector('select[aria-label="Tip"]'), "Enabled");
  await click(buttonNamed(container, "Save as draft"));
  await settle(10);
  expect(alerts(container).some((text) => text?.startsWith(invalidText))).toBe(true);
  await connection(false);
  await connection(true);
  expect(alerts(container).some((text) => text?.startsWith(invalidText))).toBe(true);
});

it("b23 review: the start the open Store runs on is read again when the connection came back mid-read", async () => {
  liveReads.count = 0;
  const { container } = await page(async () => ok());
  await click(buttonNamed(container, "1. Time zone and business day"));
  await settle(10);
  expect(liveReads.count).toBeGreaterThan(0);
  await connection(false);
  const before = liveReads.count;
  await connection(true);
  await settle(10);
  expect(liveReads.count).toBeGreaterThan(before);
});

it("b23 review: a lost save that did not go through keeps what was typed, ready to save again", async () => {
  const s = server(snapshot(1, "04:00:00"));
  const container = await serverPage(s);
  await click(buttonNamed(container, "1. Time zone and business day"));
  await typeInto(startField(container), "05:00");
  s.state.holdSaves = true;
  s.state.dropHeld = true;
  await click(buttonNamed(container, "Save as draft"));
  await settle(20);
  await connection(false);
  s.state.holdSaves = false;
  await connection(true);
  await settle(20);
  expect(s.commands).toContain("ResolveOriginal");
  expect(alerts(container)).not.toContain(conflictText);
  expect(container.textContent).toContain(
    "The original save was not committed. You can continue editing.",
  );
  expect(startField(container)?.value).toBe("05:00");
  expect(buttonNamed(container, "Save as draft")?.hasAttribute("disabled")).toBe(false);
});
