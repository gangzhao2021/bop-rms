// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { mount, settle } from "./dom-test-kit.fixture.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { StoreWasteDetailPage, StoreWasteListPage } from "./StoreWastePages.js";
import type { StoreWasteClient, StoreWasteView } from "./store-waste-pages.js";

const id = (n: number) => "01a4d900-0000-7000-8000-" + n.toString(16).padStart(12, "0");
afterEach(() => {
  setLanguageForTest("en");
  document.body.replaceChildren();
});

const record = {
  wasteReference: id(1),
  lines: [
    {
      lineReference: id(2),
      itemReference: id(3),
      locationReference: id(4),
      lotReference: null,
      quantity: "1.5",
      reasonCode: "DROPPED",
      note: null,
      unitCode: "L",
      unitCostMinor: 200,
      valueMinor: 300,
    },
  ],
  valueMinor: 300,
  costUnknown: false,
  needsReview: false,
  recordedBy: id(5),
  recordedAt: "2026-10-07T22:55:00.000Z",
  review: {
    decision: "Voided" as const,
    reasonCode: "ENTERED_IN_ERROR",
    reviewedBy: id(6),
    reviewedAt: "2026-10-07T23:00:00.000Z",
  },
};
function view(screenId: StoreWasteView["screenId"]): StoreWasteView {
  return {
    screenId,
    sourceAsOf: "2026-10-07T23:01:00.000Z",
    viewer: id(6),
    permissions: { mayRecord: true, mayRead: true, mayReview: true },
    reasons: ["DROPPED"],
    acceptReasons: [],
    voidReasons: ["ENTERED_IN_ERROR"],
    reviewThresholdMinor: 5000,
    items: [
      {
        itemReference: id(3),
        name: "Soy milk",
        unitCode: "L",
        ledgerPrecision: 3,
        lotTracking: "None",
      },
    ],
    locations: [{ locationReference: id(4), name: "Walk-in" }],
    stock: [],
    people: { [id(5)]: "Sam", [id(6)]: "You" },
    records: [record],
    hasMore: false,
  };
}
const client: StoreWasteClient = {
  load: async ({ wasteReference }) =>
    view(wasteReference === null ? "INV-WASTE-LIST" : "INV-WASTE-DETAIL"),
};

it("WP-2423 M122 (v15 live check): a voided waste record reads in Chinese, with no English word or unit code", async () => {
  setLanguageForTest("zh-Hans");
  const { container } = await mount(
    <MemoryRouter initialEntries={[`/operations/inventory/waste/${id(1)}`]}>
      <Routes>
        <Route
          path="/operations/inventory/waste/:id"
          element={<StoreWasteDetailPage client={client} />}
        />
      </Routes>
    </MemoryRouter>,
  );
  await settle();
  const text = container.textContent ?? "";
  expect(text).toContain("已由 你 作废（录入错误）");
  expect(text).toContain("1.5 升");
  expect(text).not.toMatch(/voided|reviewed|\bYou\b|\bL\b/u);
});

it("WP-2423 M122 (v15 live check): the waste list writes units in Chinese and says voided by in English", async () => {
  setLanguageForTest("zh-Hans");
  const list = await mount(
    <MemoryRouter>
      <StoreWasteListPage client={client} />
    </MemoryRouter>,
  );
  await settle();
  expect(list.container.textContent).toContain("Soy milk 1.5 升");
  expect(list.container.textContent).not.toMatch(/1\.5 L\b/u);
  document.body.replaceChildren();
  setLanguageForTest("en");
  const { container } = await mount(
    <MemoryRouter initialEntries={[`/operations/inventory/waste/${id(1)}`]}>
      <Routes>
        <Route
          path="/operations/inventory/waste/:id"
          element={<StoreWasteDetailPage client={client} />}
        />
      </Routes>
    </MemoryRouter>,
  );
  await settle();
  expect(container.textContent).toContain("voided by You (Entered in error)");
  expect(container.textContent).toContain("1.5 L");
});
