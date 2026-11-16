// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  StorePaymentConfigurationEditor,
  StoreSetupDraftReview,
  StoreSetupFeeContextEditor,
  buildStoreSetupEditedContent,
  storeSetupFeeProblems,
  storeSetupReviewContent,
} from "./StoreSetupDraftPage.js";
import { StoreConfigurationOrdinaryPanel } from "./StoreConfigurationOrdinaryPanel.js";
import { ReceiptTemplateStoreSelection } from "./ReceiptTemplateStoreSelection.js";
import { StorePublicProfilePanel } from "./StorePublicProfilePanel.js";
import { StoreReceiptPrivacyPanel } from "./StoreReceiptPrivacyPanel.js";
import { StoreKitchenSetupPanel } from "./StoreKitchenSetupPanel.js";
import { StoreSupportAccessPanel } from "./StoreSupportAccessPanel.js";
import { StoreSoleOperatorPanel } from "./SoleOperatorSection.js";
import { StarterRoleSetOffer } from "./StarterRoleSets.js";
import { parseStorePaymentConfigurationCurrent } from "./store-payment-configuration-client.js";
import {
  createUnconfiguredStoreSetupContentV2,
  StoreSetupClientError,
  type StoreSetupContent,
} from "./store-setup-client.js";
import type { StoreConfigurationSnapshot } from "./store-configuration-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { mount as mountRoot, settle } from "./dom-test-kit.fixture.js";
import type { Root } from "react-dom/client";

/**
 * b24 (Owner 2026-11-16): "服务费的订单类型为什么可以勾选服务方式没有勾选的选项？" and "3. 费用、税务
 * 和付款 这个页面还是很难看"; and from the b23 live check, Store setup sections that failed to read
 * while offline read again by themselves once the connection is back.
 */
const kitchen = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./store-kitchen-setup-client.js", async (original) => ({
  ...(await original<typeof import("./store-kitchen-setup-client.js")>()),
  createStoreKitchenSetupClient: () => ({ load: kitchen.load, apply: vi.fn() }),
}));
const support = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("./store-support-client.js", async (original) => {
  const actual = await original<typeof import("./store-support-client.js")>();
  return {
    ...actual,
    storeSupportClient: { ...actual.storeSupportClient, access: support.access },
  };
});

const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-11-16T17:32:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const csrf = "a".repeat(43);
const fees = (
  serviceOrders: readonly ("DineIn" | "Pickup" | "Delivery")[],
  delivery: "Unconfigured" | "Disabled" | "Enabled" = "Disabled",
): NonNullable<StoreSetupContent["feeContexts"]> => ({
  state: "Configured",
  value: [
    {
      chargeType: "ServiceCharge",
      state: "Enabled",
      taxClassificationReference: id(40),
      orderTypes: serviceOrders,
    },
    delivery === "Enabled"
      ? {
          chargeType: "DeliveryFee",
          state: "Enabled",
          taxClassificationReference: id(40),
          orderTypes: ["Delivery"],
        }
      : { chargeType: "DeliveryFee", state: delivery },
    { chargeType: "Tip", state: "Disabled" },
  ],
});
const setup = (change: Partial<StoreSetupContent> = {}): StoreSetupContent => ({
  ...createUnconfiguredStoreSetupContentV2(),
  timeZone: { state: "Configured", value: "America/Toronto" },
  businessDayStartLocalTime: { state: "Configured", value: "04:00:00" },
  enabledServiceModes: { state: "Configured", value: ["DineIn", "Pickup"] },
  ...change,
});
const inputs = (serviceModes: readonly ("DineIn" | "Pickup" | "Delivery")[]) => ({
  timeZone: "America/Toronto",
  businessStart: "04:00",
  serviceModes,
  hours: null,
});
const never = { classifications: () => new Promise(() => undefined) } as never;
const feeEditor = (value: NonNullable<StoreSetupContent["feeContexts"]>, offered: string[]) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <StoreSetupFeeContextEditor
        scope={scope}
        csrf={csrf}
        value={value}
        disabled={false}
        onChange={vi.fn()}
        client={never}
        offered={offered as never}
        servicesWhere="第 2 步，服务"
      />
    </MemoryRouter>,
  );
// Each test's sections are unmounted after it, so none still listens for the connection.
const roots: Root[] = [];
const mount = async (node: ReactNode) => {
  const mounted = await mountRoot(node);
  roots.push(mounted.root);
  return mounted;
};
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  setLanguageForTest("en");
  document.body.replaceChildren();
  vi.restoreAllMocks();
  kitchen.load.mockReset();
  support.access.mockReset();
});

it("b24: a fee offers only the order types the setup's services offer (unsaved step 2 included)", () => {
  setLanguageForTest("zh-Hans");
  const html = feeEditor(fees(["DineIn"]), ["DineIn", "Pickup"]);
  const group =
    /<fieldset class="store-setup-row__modes">[\s\S]*?<\/fieldset>/u.exec(html)?.[0] ?? "";
  expect(group).toContain("堂食");
  expect(group).toContain("自取");
  expect(group).not.toContain("配送");
  // Step 2 turned pickup off (not saved yet): pickup is no longer offered for the fee.
  const narrower = feeEditor(fees(["DineIn"]), ["DineIn"]);
  const only = /<fieldset class="store-setup-row__modes">[\s\S]*?<\/fieldset>/u.exec(narrower)?.[0];
  expect(only).not.toContain("自取");
});

it("b24: a fee that still names an order type step 2 turned off says so at the fee, to untick", () => {
  setLanguageForTest("zh-Hans");
  const html = feeEditor(fees(["DineIn", "Pickup"]), ["DineIn"]);
  // Still shown (ticked), so it can be unticked, with what to do.
  expect(html).toMatch(/<input type="checkbox" checked=""\/>自取/u);
  expect(html).toContain("本店不提供自取。请在这里取消勾选，或在第 2 步，服务中提供自取。");
});

it("b24: with no delivery offered, the delivery fee is a sentence, not an on/off", () => {
  setLanguageForTest("zh-Hans");
  const off = feeEditor(fees(["DineIn"], "Unconfigured"), ["DineIn", "Pickup"]);
  expect(off).toContain("本店不提供配送，所以不收配送费。");
  expect(off).not.toContain('aria-label="配送费"');
  // One still on (saved earlier) is shown with its on/off, to be put right.
  const on = feeEditor(fees(["DineIn"], "Enabled"), ["DineIn", "Pickup"]);
  expect(on).toContain('aria-label="配送费"');
  expect(on).toContain("本店不提供配送。请关闭配送费，或在第 2 步，服务中提供配送。");
  // With delivery offered, it is an ordinary on/off.
  const offered = feeEditor(fees(["DineIn"], "Disabled"), ["DineIn", "Delivery"]);
  expect(offered).toContain('aria-label="配送费"');
  expect(offered).not.toContain("本店不提供配送");
});

it("b24: a setup whose fee names a service it does not offer is never built for saving", () => {
  const content = setup({ feeContexts: fees(["DineIn", "Pickup"]) });
  expect(() => buildStoreSetupEditedContent(content, inputs(["DineIn"]))).toThrow(
    StoreSetupClientError,
  );
  expect(() => buildStoreSetupEditedContent(content, inputs(["DineIn", "Pickup"]))).not.toThrow();
  // No delivery offered: a delivery fee not set yet is saved as off.
  const built = buildStoreSetupEditedContent(
    setup({ feeContexts: fees(["DineIn"], "Unconfigured") }),
    inputs(["DineIn", "Pickup"]),
  );
  expect(built.feeContexts?.state === "Configured" && built.feeContexts.value[1]).toEqual({
    chargeType: "DeliveryFee",
    state: "Disabled",
  });
});

it("b24: Review names the fee and both places to put it right; nothing is sent", () => {
  setLanguageForTest("zh-Hans");
  const edited = setup({ feeContexts: fees(["DineIn", "Pickup"]) });
  const problems = storeSetupFeeProblems(edited, ["DineIn"]);
  expect(problems).toEqual([
    { chargeType: "ServiceCharge", kind: "NotOffered", modes: ["Pickup"] },
  ]);
  const html = renderToStaticMarkup(
    <StoreSetupDraftReview
      content={storeSetupReviewContent(
        setup({
          enabledServiceModes: { state: "Configured", value: ["DineIn"] },
          feeContexts: fees(["DineIn", "Pickup"]),
        }),
        problems,
      )}
      feeProblems={problems}
      saved={setup()}
      layout="Open"
      current={null}
    />,
  );
  expect(html).toContain("需要先改正");
  expect(html).toContain(
    "服务费适用于自取订单，但这份设置没有提供自取。请在第 3 步，费用、税务和付款中取消勾选自取，或在第 2 步，服务方式中提供自取。",
  );
});

it("b24: no change is created from a saved setup whose fee names a service it does not offer", async () => {
  setLanguageForTest("zh-Hans");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const content = {
    ...setup({
      enabledServiceModes: { state: "Configured", value: ["DineIn"] },
      feeContexts: fees(["DineIn", "Pickup"]),
    }),
  };
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
  const workspace = {
    profile: "StoreConfigurationOrdinaryWorkspaceV1",
    scope,
    latest: null,
    current,
    expectedHead: { configurationReference: id(20), configurationVersion: 1, contentDigest: null },
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
  const missing = await import("./store-setup-missing.js");
  vi.spyOn(missing, "storeSetupMissingItems").mockReturnValue([]);
  const { container } = await mount(
    <MemoryRouter>
      <StoreConfigurationOrdinaryPanel
        scope={scope}
        csrf={csrf}
        saved={
          {
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            setupDraftReference: id(30),
            revision: 1,
            baseConfigurationReference: id(20),
            content,
          } as never
        }
        setupLayout="Open"
        client={client as never}
        journalFactory={
          (() => ({ load: vi.fn(async () => null), reserve: vi.fn(), complete: vi.fn() })) as never
        }
      />
    </MemoryRouter>,
  );
  await settle();
  const text = container.textContent ?? "";
  expect(text).toContain(
    "还不能生成修改：这份已保存设置里，服务费适用于自取，但本店没有提供这些服务。",
  );
  expect(text).not.toContain("用已保存的设置生成修改");
  expect(client.prepare).not.toHaveBeenCalled();
});

const paymentCurrent = () =>
  parseStorePaymentConfigurationCurrent(
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
      validUntil: "2026-11-16T17:32:05.000Z",
      providerReadiness: "NotEvaluated",
    },
    id(3),
    scope,
  );
const goOnline = async () => {
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await settle();
};

it("b24: payment methods read while offline are 'not known yet', never unticked, and read again once online", async () => {
  setLanguageForTest("zh-Hans");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const load = vi
    .fn()
    .mockRejectedValueOnce(new StoreSetupClientError("Unavailable"))
    .mockResolvedValue(paymentCurrent());
  const { container } = await mount(
    <StorePaymentConfigurationEditor
      scope={scope}
      csrf={csrf}
      onSelect={vi.fn()}
      client={{ load } as never}
      journalFactory={() => ({ load: async () => null }) as never}
    />,
  );
  await settle();
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(container.textContent).toContain("还不知道本店现在的付款方式。");
  expect(container.textContent).not.toContain("保存付款方式");
  await goOnline();
  expect(load).toHaveBeenCalledTimes(2);
  const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.map((box) => box.checked)).toEqual([true, true, false]);
  expect(container.textContent).not.toContain("还不知道");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

const failing = () => vi.fn(async () => Promise.reject(new Error("offline")));
const panels: readonly (readonly [string, () => { node: ReactNode; calls: () => number }])[] = [
  [
    "Store details",
    () => {
      const load = failing();
      return {
        node: <StorePublicProfilePanel csrf={csrf} client={{ load } as never} />,
        calls: () => load.mock.calls.length,
      };
    },
  ],
  [
    "Receipts and tax numbers",
    () => {
      const load = failing();
      return {
        node: <StoreReceiptPrivacyPanel csrf={csrf} client={{ load } as never} />,
        calls: () => load.mock.calls.length,
      };
    },
  ],
  [
    "Kitchen setup",
    () => {
      kitchen.load.mockRejectedValue(new Error("offline"));
      return {
        node: <StoreKitchenSetupPanel csrf={csrf} />,
        calls: () => kitchen.load.mock.calls.length,
      };
    },
  ],
  [
    "Platform support",
    () => {
      support.access.mockRejectedValue(new Error("offline"));
      return {
        node: <StoreSupportAccessPanel csrf={csrf} />,
        calls: () => support.access.mock.calls.length,
      };
    },
  ],
  [
    "Sole operator",
    () => {
      const fetcher = vi.fn(async () => Promise.reject(new TypeError("offline")));
      return {
        node: <StoreSoleOperatorPanel csrf={csrf} fetcher={fetcher as never} />,
        calls: () => fetcher.mock.calls.length,
      };
    },
  ],
  [
    "Roles for your kind of shop",
    () => {
      const starterSets = failing();
      return {
        node: (
          <StarterRoleSetOffer
            client={{ starterSets, loadRoles: failing() } as never}
            csrf={csrf}
            place="StoreSetup"
          />
        ),
        calls: () => starterSets.mock.calls.length,
      };
    },
  ],
  [
    "Fee tax classes",
    () => {
      const classifications = vi.fn(async () =>
        Promise.reject(new StoreSetupClientError("Unavailable")),
      );
      return {
        node: (
          <StoreSetupFeeContextEditor
            scope={scope}
            csrf={csrf}
            value={{ state: "Unconfigured" }}
            disabled={false}
            onChange={vi.fn()}
            client={{ classifications } as never}
          />
        ),
        calls: () => classifications.mock.calls.length,
      };
    },
  ],
  [
    "Receipt template choice",
    () => {
      const loadRoster = vi.fn(async () =>
        Promise.reject(new StoreSetupClientError("Unavailable")),
      );
      return {
        node: (
          <ReceiptTemplateStoreSelection
            scope={scope}
            locale="en"
            csrf={csrf}
            value={{ state: "Unconfigured" }}
            onSelect={vi.fn()}
            rosterClient={{ loadRoster } as never}
            client={{ load: vi.fn() } as never}
          />
        ),
        calls: () => loadRoster.mock.calls.length,
      };
    },
  ],
];
it.each(panels)(
  "b24 (v15 live check of b23): %s, read while offline, reads again by itself once online",
  async (_name, make) => {
    const { node, calls } = make();
    await mount(<MemoryRouter>{node}</MemoryRouter>);
    await settle();
    expect(calls()).toBe(1);
    await goOnline();
    expect(calls()).toBe(2);
  },
);
