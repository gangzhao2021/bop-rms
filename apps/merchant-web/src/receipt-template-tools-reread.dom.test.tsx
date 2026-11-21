// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptTemplateArtifactEditor } from "./ReceiptTemplateArtifactEditor.js";
import { ReceiptTemplateDraftEditor } from "./ReceiptTemplateDraftEditor.js";
import {
  createReceiptTemplateArtifactClient,
  type ReceiptTemplateArtifactContent,
  type ReceiptTemplateArtifactCursor,
  type ReceiptTemplateArtifactReceipt,
} from "./receipt-template-artifact-client.js";
import type { ReceiptTemplateArtifactPendingJournal } from "./receipt-template-artifact-pending-journal.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { click, mount, settle, until } from "./dom-test-kit.fixture.js";

/**
 * b25 (v15 live check of b24): the receipt template tools under Receipts and tax numbers have no
 * Refresh buttons of their own. A read cut off by the connection is made again once it is back
 * (b23/b24); a preset changed elsewhere is read again by itself; a saved preset is offered to the
 * template draft below by itself; and a save the server refuses outright is let go.
 */
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-11-16T10:00:00.000Z",
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  csrf = "A".repeat(43);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  setLanguageForTest("en");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function server() {
  const state = {
    layout: null as ReceiptTemplateArtifactReceipt["snapshot"],
    cursor: null as ReceiptTemplateArtifactCursor | null,
    answer: "accept" as "accept" | 400 | 409,
    reads: 0,
  };
  const snapshot = (revision: number, content: unknown) => ({
    profile: "DigitalReceiptTemplateArtifactV1" as const,
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    artifactKind: "Layout" as const,
    artifactReference: id(8 + revision),
    revision,
    authoredByReference: scope.actorReference,
    previousArtifactReference: null,
    content: content as ReceiptTemplateArtifactContent,
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal" as const,
  });
  const client = createReceiptTemplateArtifactClient(
    vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method !== "POST") {
        state.reads++;
        return json({
          profile: "DigitalReceiptTemplateArtifactsCurrentV1",
          ...scope,
          layout: state.layout,
          compliance: null,
          observedAt: at,
          validUntil: "2026-11-16T10:00:05.000Z",
          sourceQualification: "NotEvaluated",
        });
      }
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      if (state.answer !== "accept") {
        // Someone else saved this preset meanwhile.
        if (state.answer === 409) state.layout = snapshot(1, body.content);
        return json({ error: "conflict" }, state.answer);
      }
      const c = state.cursor;
      if (!c) throw new Error("not reserved");
      state.layout = snapshot(c.expectedRevision + 1, body.content);
      return json({
        profile: "DigitalReceiptTemplateArtifactReceiptV1",
        ...scope,
        artifactKind: c.artifactKind,
        operationReference: c.operationReference,
        intentDigest: c.intentDigest,
        expectedArtifactReference: c.expectedArtifactReference,
        expectedRevision: c.expectedRevision,
        outcome: "Committed",
        snapshot: state.layout,
        auditReference: id(20),
        occurredAt: at,
      });
    }),
  );
  const journal: ReceiptTemplateArtifactPendingJournal = {
    load: async () => state.cursor,
    reserve: async (c) => {
      state.cursor = c;
    },
    complete: async () => {
      state.cursor = null;
    },
    release: vi.fn(async () => {
      state.cursor = null;
    }),
  };
  return { state, client, journal };
}
const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
const layoutSection = (container: HTMLElement) =>
  container.querySelector('[aria-label="receipt layout"]') as HTMLElement;
async function open(s: ReturnType<typeof server>, onSaved = vi.fn()) {
  const { container } = await mount(
    <ReceiptTemplateArtifactEditor
      scope={scope}
      csrf={csrf}
      client={s.client}
      journalFactory={() => s.journal}
      onSaved={onSaved}
    />,
  );
  await settle(10);
  return container;
}
const saveLayout = (container: HTMLElement) =>
  [...layoutSection(container).querySelectorAll("button")].find(
    (b) => b.textContent === "Save receipt layout",
  );

it("b25: receipt presets show no Refresh button, in English or Chinese", async () => {
  const container = await open(server());
  expect(buttons(container).some((text) => text.startsWith("Refresh"))).toBe(false);
  document.body.replaceChildren();
  setLanguageForTest("zh-Hans");
  const zh = await open(server());
  expect(buttons(zh).some((text) => text.includes("刷新"))).toBe(false);
  expect(zh.textContent).not.toContain("刷新");
});

it("b25: a preset saved elsewhere meanwhile is read again by itself and can be saved again", async () => {
  const s = server();
  const container = await open(s);
  s.state.answer = 409;
  const before = s.state.reads;
  await click(saveLayout(container));
  await until(() => layoutSection(container).textContent?.includes("changed elsewhere") === true);
  await until(() => s.state.reads > before + 1);
  await settle(10);
  expect(layoutSection(container).textContent).toContain("Saved.");
  expect(layoutSection(container).textContent).not.toContain("must be recovered");
  expect(s.journal.release).toHaveBeenCalledTimes(1);
  expect(saveLayout(container)?.hasAttribute("disabled")).toBe(false);
});

it("b25: a preset save refused with 400 is let go, with no recovery", async () => {
  const s = server();
  const container = await open(s);
  s.state.answer = 400;
  await click(saveLayout(container));
  await until(() => layoutSection(container).querySelector("[role=alert]") !== null);
  await settle(10);
  expect(s.state.cursor).toBeNull();
  expect(layoutSection(container).textContent).not.toContain("must be recovered");
  expect(saveLayout(container)).toBeDefined();
});

it("b25: a saved preset tells the template draft below, which offers it without a refresh", async () => {
  const s = server(),
    onSaved = vi.fn();
  const container = await open(s, onSaved);
  await click(saveLayout(container));
  await until(() => onSaved.mock.calls.length === 1);
  const draft = renderToStaticMarkup(
    <ReceiptTemplateDraftEditor scope={scope} csrf={csrf} defaultLocale="en-CA" />,
  );
  expect(draft).not.toContain("Refresh available presets");
  expect(draft).not.toContain("then refresh");
});

// b26 (v15 live check of b25): both presets come from one read, so an outage is said once, in the
// page's language, saying it is read again by itself; Try again reads both presets again.
it("b26: a preset read cut off by the connection shows one alert, and Try again reads both again", async () => {
  for (const language of ["en", "zh-Hans"] as const) {
    setLanguageForTest(language);
    const s = server();
    let down = true;
    const reads = vi.fn();
    const client = createReceiptTemplateArtifactClient(
      vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
        if (options?.method !== "POST") reads();
        if (down) return new Response("{}", { status: 503 });
        return json({
          profile: "DigitalReceiptTemplateArtifactsCurrentV1",
          ...scope,
          layout: null,
          compliance: null,
          observedAt: at,
          validUntil: "2026-11-16T10:00:05.000Z",
          sourceQualification: "NotEvaluated",
        });
      }),
    );
    const { container } = await mount(
      <ReceiptTemplateArtifactEditor
        scope={scope}
        csrf={csrf}
        client={client}
        journalFactory={() => s.journal}
      />,
    );
    await until(() => container.querySelectorAll("[role=alert]").length > 0);
    await settle(10);
    const alerts = [...container.querySelectorAll("[role=alert]")].map((n) => n.textContent ?? "");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(
      language === "en"
        ? "Receipt styles could not be loaded. They are read again once the connection is back"
        : "无法加载收据样式。网络恢复后会自动重新读取",
    );
    expect(alerts[0]).not.toContain(language === "en" ? "Refresh" : "刷新");
    down = false;
    const before = reads.mock.calls.length;
    await click(
      [...container.querySelectorAll("button")].find(
        (b) => b.textContent === (language === "en" ? "Try again" : "重试"),
      ),
    );
    await until(() => reads.mock.calls.length >= before + 2);
    await settle(10);
    expect(container.querySelectorAll("[role=alert]")).toHaveLength(0);
    document.body.replaceChildren();
  }
});

it("b26: the template draft read cut off says it is read again by itself, never to refresh", async () => {
  for (const language of ["en", "zh-Hans"] as const) {
    setLanguageForTest(language);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    try {
      const { container } = await mount(
        <ReceiptTemplateDraftEditor scope={scope} csrf={csrf} defaultLocale="en-CA" />,
      );
      await until(() => container.querySelector("[role=alert]") !== null);
      await settle(10);
      const text = container.querySelector("[role=alert]")?.textContent ?? "";
      expect(text).toContain(
        language === "en"
          ? "The receipt draft could not be loaded. It is read again by itself once the connection is back"
          : "无法加载收据草稿。网络恢复后会自动重新读取",
      );
      expect(text).not.toContain(language === "en" ? "Refresh when connected" : "联网后请刷新");
      expect(
        [...container.querySelectorAll("button")].some(
          (b) => b.textContent === (language === "en" ? "Try again" : "重试"),
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    }
  }
});
