// @vitest-environment jsdom
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
  mount,
  settle,
  typeInto,
  unmountMounted,
  until,
} from "./dom-test-kit.fixture.js";

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
      load: (_scope: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("gone", "AbortError")),
          ),
        ),
    }),
  };
});

/**
 * b25 (v15 live check of b24): a save the server refuses outright (400 invalid, 403 not allowed,
 * 409 changed meanwhile) proves nothing was written. The page lets go of it, so staff put it right
 * and save again; only an answer that never came keeps "An earlier save has not been cleared".
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
const recoveryText = "An earlier save has not been cleared. A new save is blocked.";
const savedText = "Setup draft saved. These settings have not been validated or published.";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
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
function server() {
  const state = {
    saved: snapshot(1, "04:00:00") as StoreSetupSnapshot | null,
    cursor: null as StoreSetupCursor | null,
    // How the server answers the next save: a refusal status, or accept it.
    answer: 400 as number | "accept",
  };
  const commands: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") {
      commands.push("read");
      return json({
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
          snapshot: state.saved,
          observedAt: new Date(Date.now()).toISOString(),
          validUntil: new Date(Date.now() + 5000).toISOString(),
          businessReferenceValidation: "NotEvaluated",
        },
      });
    }
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    commands.push(String(sent.command));
    if (sent.command !== "SaveDraft") return json({ error: "unexpected" }, 400);
    if (state.answer !== "accept")
      return json(
        {
          error:
            state.answer === 400
              ? "store_setup_invalid"
              : state.answer === 403
                ? "request_denied"
                : state.answer === 409
                  ? "store_setup_conflict"
                  : "store_setup_unavailable",
        },
        state.answer,
      );
    const content = sent.content as StoreSetupSnapshot["content"];
    state.saved = { ...snapshot(Number(sent.expectedRevision) + 1, "04:00:00"), content };
    return json({
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
    });
  });
  const same = (a: StoreSetupCursor, b: StoreSetupCursor) =>
    a.operationReference === b.operationReference;
  const journal: StoreSetupPendingJournal = {
    load: async () => state.cursor,
    reserve: vi.fn(async (cursor: StoreSetupCursor) => {
      state.cursor = cursor;
    }),
    complete: vi.fn(async () => {
      state.cursor = null;
    }),
    release: vi.fn(async (cursor: StoreSetupCursor) => {
      if (state.cursor !== null && !same(state.cursor, cursor)) throw new Error("other original");
      state.cursor = null;
    }),
  };
  return { state, fetcher, journal, commands };
}
async function open(s: ReturnType<typeof server>) {
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
const alerts = (container: HTMLElement) =>
  [...container.querySelectorAll("[role=alert]")].map((node) => node.textContent ?? "");
const refusal = (container: HTMLElement) =>
  container.querySelector("#setup-validation-error")?.textContent ?? null;
const startField = (container: HTMLElement) =>
  [...container.querySelectorAll("label")]
    .find(
      (label) =>
        label.textContent?.includes("Business day starts at (local time)") ||
        label.textContent?.includes("营业日开始于（当地时间）"),
    )
    ?.querySelector("input") as HTMLInputElement | null;
const disabled = (container: HTMLElement, name: string) =>
  buttonNamed(container, name)?.hasAttribute("disabled");
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(async () => {
  await unmountMounted();
  setLanguageForTest("en");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function refusedSave(status: number) {
  const s = server();
  s.state.answer = status;
  const container = await open(s);
  await click(buttonNamed(container, "1. Time zone and business day"));
  await typeInto(startField(container), "05:00");
  await click(buttonNamed(container, "Save as draft"));
  await until(() => s.commands.includes("SaveDraft") && alerts(container).length > 0);
  await settle(10);
  return { s, container };
}

for (const [status, alert] of [
  // b26: the general check list starts by saying the draft was not saved.
  // b28 (v15 live26): the server does not say which rule failed: one sentence, never every rule.
  [
    400,
    "This draft was not saved: check the times, wait times and fees you changed; step 4, Review and publish, lists what to change under “Still needed”.",
  ],
  [403, "Your current permission or selected Store does not allow this action."],
  [409, "The saved settings or their baseline changed."],
] as const)
  it(`b25: a save refused with ${status} is let go: no recovery, Save and Discard stay usable`, async () => {
    const { s, container } = await refusedSave(status);
    expect(alerts(container).some((text) => text.startsWith(alert))).toBe(true);
    expect(alerts(container).join(" ")).not.toContain("1,440");
    expect(container.textContent).not.toContain(recoveryText);
    expect(buttonNamed(container, "Recover original save")).toBeUndefined();
    expect(s.journal.release).toHaveBeenCalledTimes(1);
    expect(s.state.cursor).toBeNull();
    expect(s.commands).not.toContain("ResolveOriginal");
    // What was typed stays, and can be saved again or discarded.
    expect(startField(container)?.value).toBe("05:00");
    expect(disabled(container, "Save as draft")).toBe(false);
    expect(disabled(container, "Discard unsaved changes")).toBe(false);
  });

it("b25: once put right, the refused save is saved again without a recovery", async () => {
  const { s, container } = await refusedSave(400);
  s.state.answer = "accept";
  await click(buttonNamed(container, "Save as draft"));
  await until(() => container.textContent?.includes(savedText) === true);
  expect(s.commands.filter((c) => c === "SaveDraft")).toHaveLength(2);
  expect(s.commands).not.toContain("ResolveOriginal");
  expect(s.state.saved?.revision).toBe(2);
});

it("b25: a save whose answer is a 503 (outcome unknown) still keeps the recovery path", async () => {
  const s = server();
  s.state.answer = 503;
  const container = await open(s);
  await click(buttonNamed(container, "1. Time zone and business day"));
  await typeInto(startField(container), "05:00");
  await click(buttonNamed(container, "Save as draft"));
  await until(() => container.textContent?.includes(recoveryText) === true);
  expect(s.journal.release).not.toHaveBeenCalled();
  expect(s.state.cursor).not.toBeNull();
  expect(disabled(container, "Save as draft")).toBe(true);
});

it("b25: in Chinese, a refused save shows no recovery line", async () => {
  setLanguageForTest("zh-Hans");
  const s = server();
  const container = await open(s);
  // Step names are read when the module loads (the language switch reloads the page).
  await click(
    [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("1. ")),
  );
  await typeInto(startField(container), "05:00");
  await click(buttonNamed(container, "存为草稿"));
  await until(() => s.commands.includes("SaveDraft") && alerts(container).length > 0);
  await settle(10);
  expect(container.textContent).not.toContain("之前的保存尚未清除");
  expect(buttonNamed(container, "恢复原来的保存")).toBeUndefined();
  // b26: and says first that the draft was not saved.
  expect(alerts(container)).toContain(
    "这份草稿没有保存：请检查你改过的时间、等待时间和费用，第 4 步“核对并发布”里的“还需要”会列出要改的地方。",
  );
});

/** A saved draft offering dine-in only, whose tip still applies to pickup orders too. */
function tipOnPickupNotOffered(s: ReturnType<typeof server>) {
  const base = snapshot(1, "04:00:00");
  s.state.saved = {
    ...base,
    content: {
      ...base.content,
      enabledServiceModes: { state: "Configured", value: ["DineIn"] },
      feeContexts: {
        state: "Configured",
        value: [
          { chargeType: "ServiceCharge", state: "Disabled" },
          { chargeType: "DeliveryFee", state: "Disabled" },
          {
            chargeType: "Tip",
            state: "Enabled",
            taxClassificationReference: null,
            orderTypes: ["DineIn", "Pickup"],
          },
        ],
      },
    } as StoreSetupSnapshot["content"],
  };
}
it("b26: a save the page refuses says so in one short sentence; the detail is in Review only", async () => {
  const s = server();
  tipOnPickupNotOffered(s);
  const container = await open(s);
  await click(buttonNamed(container, "Save as draft"));
  await until(() => alerts(container).length > 0);
  expect(s.commands).not.toContain("SaveDraft");
  expect(refusal(container)).toBe(
    "This draft was not saved: 1 fee setting needs fixing first, see “Needs fixing first” below.",
  );
  expect(alerts(container).join(" ")).not.toContain("Tip applies to Pickup orders");
  expect(alerts(container).join(" ")).not.toContain("Each service interval needs valid times");
  // Review, shown now, lists the same sentence under "Needs fixing first".
  expect(container.querySelector('[aria-label="Needs fixing first"]')?.textContent).toContain(
    "Tip applies to Pickup orders, but this setup does not offer Pickup.",
  );
});
it("b26: in Chinese, two fees to fix read as one sentence above the steps, listed once in Review", async () => {
  setLanguageForTest("zh-Hans");
  const s = server();
  tipOnPickupNotOffered(s);
  const saved = s.state.saved as StoreSetupSnapshot;
  const fees = saved.content.feeContexts as { state: "Configured"; value: unknown[] };
  s.state.saved = {
    ...saved,
    content: {
      ...saved.content,
      feeContexts: {
        state: "Configured",
        value: fees.value.map((fee) =>
          (fee as { chargeType: string }).chargeType === "ServiceCharge"
            ? {
                ...(fee as object),
                state: "Enabled",
                taxClassificationReference: id(9),
                orderTypes: ["DineIn", "Pickup"],
              }
            : fee,
        ),
      },
    } as StoreSetupSnapshot["content"],
  };
  const container = await open(s);
  await click(buttonNamed(container, "存为草稿"));
  await until(() => alerts(container).length > 0);
  expect(s.commands).not.toContain("SaveDraft");
  expect(refusal(container)).toBe("这份草稿没有保存：有 2 处要先改正，见下方“需要先改正”。");
  const review = container.querySelector('[aria-label="需要先改正"]');
  expect(review?.querySelectorAll("li")).toHaveLength(2);
  expect(review?.textContent).toContain("小费适用于自取订单，但这份设置没有提供自取。");
  expect(review?.textContent).toContain("服务费适用于自取订单");
});
