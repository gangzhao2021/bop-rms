// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  StorePaymentConfigurationEditor,
  StoreSetupDraftReview,
  StoreSetupFeeContextEditor,
  storeSetupChangeSummary,
  storeSetupFeeProblems,
  storeSetupReviewContent,
  type StorePaymentUnsavedChange,
} from "./StoreSetupDraftPage.js";
import { StoreConfigurationOrdinaryPanel } from "./StoreConfigurationOrdinaryPanel.js";
import { parseStorePaymentConfigurationCurrent } from "./store-payment-configuration-client.js";
import {
  createUnconfiguredStoreSetupContentV2,
  type StoreSetupContent,
} from "./store-setup-client.js";
import type { StoreConfigurationSnapshot } from "./store-configuration-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { mount, settle } from "./dom-test-kit.fixture.js";

// The panel's own check of setup completeness is not what is tested here: the panel test reads a
// setup with every other setting set.
const completeness = vi.hoisted(() => ({ complete: false }));
vi.mock("./store-setup-missing.js", async (original) => {
  const actual = await original<typeof import("./store-setup-missing.js")>();
  return {
    ...actual,
    storeSetupMissingItems: (...args: Parameters<typeof actual.storeSetupMissingItems>) =>
      completeness.complete ? [] : actual.storeSetupMissingItems(...args),
  };
});

/**
 * b22 (v15 live check of b21, store-setup-review-gaps): what stops a setup from being sent is said
 * before a change is created; a fee left half set names its real problem; unsaved payment methods
 * count as unsaved edits.
 */
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-11-15T17:32:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const csrf = "a".repeat(43);
const current = {
  configurationReference: id(20),
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  enabledServiceModes: ["DineIn"],
  weeklySchedule: [],
  capacityConfigurationReference: null,
  addressReference: id(8),
  contactReference: id(9),
  paymentConfigurationReference: id(10),
  receiptReference: id(11),
  taxConfigurationReference: id(12),
  setupBasis: { feeContexts: [] },
  lifecycle: "Published",
  configurationVersion: 1,
  createdAt: at,
  updatedAt: at,
  effectiveFrom: at,
  effectiveUntil: null,
} as unknown as StoreConfigurationSnapshot;
const setup = (change: Partial<StoreSetupContent> = {}): StoreSetupContent => ({
  ...createUnconfiguredStoreSetupContentV2(),
  timeZone: { state: "Configured", value: "America/Toronto" },
  businessDayStartLocalTime: { state: "Configured", value: "04:00:00" },
  enabledServiceModes: { state: "Configured", value: ["DineIn"] },
  ...change,
});
afterEach(() => {
  setLanguageForTest("en");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

// Item 2: the business day start of a Store that already runs is kept (the BusinessDayStart check).
it("b22: Review flags a business day start change as cannot be sent, with the step to put it back", () => {
  setLanguageForTest("zh-Hans");
  const content = setup({ businessDayStartLocalTime: { state: "Configured", value: "04:30:00" } });
  const html = renderToStaticMarkup(
    <StoreSetupDraftReview content={content} saved={content} layout="Open" current={current} />,
  );
  expect(html).toContain("需要先改正");
  expect(html).toContain(
    "营业日开始时间：设为 04:30 的修改无法提交审批。已经营业的门店要保持 04:00，这样过去的营业日和报表才能保持界限。请在第 1 步，时区和营业日中改回 04:00。",
  );
  expect(html).toContain("无法提交审批");
  // Kept as it runs today: nothing to fix.
  const kept = renderToStaticMarkup(
    <StoreSetupDraftReview content={setup()} saved={setup()} layout="Open" current={current} />,
  );
  expect(kept).not.toContain("需要先改正");
  expect(kept).not.toContain("无法提交审批");
});

// b22 review: the sentence names where this layout sets the business day start, as Review does.
it.each([
  ["Open", "第 1 步，时区和营业日"],
  ["Opening", "第 2 步，地址和时区"],
] as const)(
  "b22: no change is created from a saved setup whose business day start differs from the Store's (%s)",
  async (layout, where) => {
    setLanguageForTest("zh-Hans");
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
    const saved = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      setupDraftReference: id(30),
      revision: 1,
      baseConfigurationReference: id(20),
      content: setup({ businessDayStartLocalTime: { state: "Configured", value: "04:30:00" } }),
    };
    const workspace = {
      profile: "StoreConfigurationOrdinaryWorkspaceV1",
      scope,
      latest: null,
      current,
      expectedHead: {
        configurationReference: id(20),
        configurationVersion: 1,
        contentDigest: null,
      },
      original: null,
      observedAt: at,
      validUntil: at,
      businessReferenceValidation: "NotEvaluated",
    };
    const client = {
      invalidate: vi.fn(),
      load: vi.fn(async () => workspace),
      prepare: vi.fn(),
      execute: vi.fn(),
      refreshOriginal: vi.fn(),
      resolve: vi.fn(),
      history: vi.fn(),
    };
    completeness.complete = true;
    const { container } = await mount(
      <MemoryRouter>
        <StoreConfigurationOrdinaryPanel
          scope={scope}
          csrf={csrf}
          saved={saved as never}
          setupLayout={layout}
          client={client as never}
          journalFactory={
            (() => ({
              load: vi.fn(async () => null),
              reserve: vi.fn(),
              complete: vi.fn(),
            })) as never
          }
        />
      </MemoryRouter>,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).not.toContain("用已保存的设置生成修改");
    expect(text).toContain(
      `还不能生成修改：这份已保存设置的营业日开始时间无法提交审批。请在${where}中改回 04:00，存为草稿，再回到这里。`,
    );
    expect(client.prepare).not.toHaveBeenCalled();
    completeness.complete = false;
  },
);

// Item 3: a tip turned on without its orders names that problem, and the rest of Review stays.
it("b22: a tip on without an order type is named at the field and in Review, and the summary stays", () => {
  setLanguageForTest("zh-Hans");
  const edited = setup({
    businessDayStartLocalTime: { state: "Configured", value: "04:00:00" },
    enabledServiceModes: { state: "Configured", value: ["DineIn", "Pickup"] },
    feeContexts: {
      state: "Configured",
      value: [
        { chargeType: "ServiceCharge", state: "Disabled" },
        { chargeType: "DeliveryFee", state: "Disabled" },
        { chargeType: "Tip", state: "Enabled", taxClassificationReference: null, orderTypes: [] },
      ],
    },
  });
  const problems = storeSetupFeeProblems(edited);
  expect(problems).toEqual([{ chargeType: "Tip", kind: "OrderTypes" }]);
  const html = renderToStaticMarkup(
    <StoreSetupDraftReview
      content={storeSetupReviewContent(edited, problems)}
      feeProblems={problems}
      saved={setup()}
      layout="Open"
      current={current}
    />,
  );
  expect(html).not.toContain("有些已编辑的时间或等待值需要先修正才能保存");
  expect(html).toContain(
    "小费已开启，但还没有选择适用于哪些订单。请在第 3 步，费用、税务和付款中选择。",
  );
  // The rest of the summary is still there: the added pickup, and the tip named as not set yet.
  expect(html).toContain("现在堂食 → 改为堂食、自取");
  expect(html).toContain("小费：开启，还没有选择适用于哪些订单");
  expect(html).not.toMatch(/小费：请在/u);
  const field = renderToStaticMarkup(
    <StoreSetupFeeContextEditor
      scope={scope}
      csrf={csrf}
      value={edited.feeContexts ?? { state: "Unconfigured" }}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(field).toContain("请选择小费适用于哪些订单。");
});

// Item 4: payment methods unticked in step 3 count as unsaved edits; the button says what it saves.
it("b22: unticking a payment method reports it as unsaved, Discard puts it back, the button reads 保存付款方式", async () => {
  setLanguageForTest("zh-Hans");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const saved = parseStorePaymentConfigurationCurrent(
    {
      profile: "StorePaymentConfigurationCurrentV1",
      ...scope,
      snapshot: {
        profile: "StorePaymentConfigurationV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        configurationReference: id(70),
        revision: 1,
        authoredByReference: id(4),
        previousConfigurationReference: null,
        content: {
          customerOnlineCardEnabled: true,
          staffTerminalCardPresentEnabled: true,
          staffTerminalInteracEnabled: false,
        },
        currencyCode: "CAD",
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
      },
      observedAt: at,
      validUntil: "2026-11-15T17:32:05.000Z",
      providerReadiness: "NotEvaluated",
    },
    id(3),
    scope,
  );
  const client = { load: vi.fn(async () => saved) };
  const reports: (readonly StorePaymentUnsavedChange[])[] = [];
  const view = (discardSignal: number) => (
    <StorePaymentConfigurationEditor
      scope={scope}
      csrf={csrf}
      onSelect={vi.fn()}
      onUnsavedChange={(changes) => reports.push(changes)}
      discardSignal={discardSignal}
      client={client as never}
      journalFactory={() => ({ load: async () => null }) as never}
    />
  );
  const { container, root } = await mount(view(0));
  await settle();
  const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent);
  // b24: nothing to save until a method is changed; then one accent action says what it saves.
  expect(buttons()).not.toContain("保存付款方式");
  expect(container.textContent).not.toContain("配置");
  const online = [...container.querySelectorAll("label")].find(
    (label) => label.textContent === "顾客在线刷卡",
  );
  const box = online?.querySelector("input");
  if (!(box instanceof HTMLInputElement)) throw new Error("payment method absent");
  expect(box.checked).toBe(true);
  await act(async () => {
    box.click();
  });
  await settle();
  expect(reports.at(-1)).toEqual([{ label: "顾客在线刷卡", on: false }]);
  expect(buttons()).toContain("保存付款方式");
  // Ticking it again is back to what is saved: nothing unsaved.
  await act(async () => {
    box.click();
  });
  await settle();
  expect(reports.at(-1)).toEqual([]);
  await act(async () => {
    box.click();
  });
  await settle();
  expect(reports.at(-1)).toHaveLength(1);
  await act(async () => {
    root.render(view(1));
  });
  await settle();
  const after = [...container.querySelectorAll("label")]
    .find((label) => label.textContent === "顾客在线刷卡")
    ?.querySelector("input");
  expect(after?.checked).toBe(true);
  expect(reports.at(-1)).toEqual([]);
});

it("b22: Review lists unsaved payment methods as a change not saved yet, never as Payment unchanged", () => {
  setLanguageForTest("zh-Hans");
  const content = setup({ paymentConfigurationReference: { state: "Configured", value: id(10) } });
  const before = storeSetupChangeSummary(content, current, content);
  expect(before.unchanged).toContain("付款");
  const summary = storeSetupChangeSummary(content, current, content, [], {
    changes: [{ label: "顾客在线刷卡", on: false }],
    where: "第 3 步，费用、税务和付款",
  });
  expect(summary.unchanged).not.toContain("付款");
  expect(summary.changed.find((item) => item.label === "付款")).toEqual({
    label: "付款",
    value: [
      "顾客在线刷卡：开 → 关",
      "请在第 3 步，费用、税务和付款中保存付款方式，为这份设置选用已保存的付款方式，然后存为草稿。",
    ],
    unsaved: true,
  });
});
