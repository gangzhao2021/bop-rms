import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  headers,
  id,
  inLanguage,
  navigation,
  quietFrame,
  scope,
  session,
  sizes,
  type Language,
} from "./merchant-shell-fixture";

/**
 * Batch 63 review (F22 extended, RA-03, RA-16): the back-office pages left out of the first pass,
 * measured at 390, 1024 and 1440 in English and Chinese. Brief §2 v3: two buttons only — the accent
 * fill for the one next step and accent words for the rest; removing a tablet or resetting a PIN is
 * red words that ask first; links are accent 14/400 words; rows are split by visible hairlines; every
 * page has the shared header (title 28/600, the language switch at its top right, one "Updated
 * hh:mm"). Synthetic HTTP interception, TEST-only data.
 */
const accent = "rgb(31, 99, 224)";
const danger = "rgb(191, 85, 82)";
const white = "rgb(255, 255, 255)";
const none = "rgba(0, 0, 0, 0)";
const hairline = "rgb(229, 229, 229)";
const at = () => new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/u, ".000Z");
const store = scope.storeReference;

const more = [
  [
    "IAM-SESSION-LIST",
    "Shared tablets & PINs",
    "/app/organization/sessions",
    "identity.store_device.manage",
  ],
  [
    "STORE-CAPABILITY",
    "Store features",
    `/app/organization/stores/${store}/capabilities`,
    "organization.manage",
  ],
  ["TASK-INBOX", "Tasks", "/app/tasks", "workflow.operate"],
].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission }));

async function frame(page: Page, language: Language) {
  await inLanguage(page, language);
  await quietFrame(page);
  const base = session();
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: { ...base, workspace: { ...base.workspace, navigation: [...navigation, ...more] } },
    }),
  );
}

/** What a control looks like: its frame, fill, words and type. */
const look = (locator: Locator) =>
  locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      border:
        style.borderTopWidth === "0px" || style.borderTopStyle === "none"
          ? "0px"
          : style.borderTopWidth,
      background: style.backgroundColor,
      color: style.color,
      size: style.fontSize,
      weight: style.fontWeight,
      underline: style.textDecorationLine,
    };
  });
const expectFill = async (locator: Locator) =>
  expect(await look(locator)).toMatchObject({ border: "0px", background: accent, color: white });
const expectWords = async (locator: Locator, color = accent) =>
  expect(await look(locator)).toMatchObject({ border: "0px", background: none, color });
/** Every accent-filled button on the page: brief §2, one per row at most. */
const fills = (page: Page, root: string) =>
  page
    .locator(root)
    .evaluate(
      (node, fill) =>
        [...node.querySelectorAll("button")].filter(
          (button) =>
            button.getBoundingClientRect().width > 0 &&
            getComputedStyle(button).backgroundColor === fill,
        ).length,
      accent,
    );
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

const words = {
  en: {
    newDish: "New dish",
    newCombo: "New combo",
    newSection: "New section",
    refresh: "Refresh",
    remove: "Remove",
    resetPin: "Reset PIN",
    setUp: "Set up this tablet for staff PINs",
    addDish: "Add this dish",
    saveRules: "Save rules",
    addSection: "Add section",
    open: "View",
    manage: "View and manage",
    cancel: "Cancel",
    updated: /^Updated \d\d:\d\d$/u,
  },
  "zh-Hans": {
    newDish: "新建菜品",
    newCombo: "新套餐",
    newSection: "新建分类",
    refresh: "刷新",
    remove: "移除",
    resetPin: "重置 PIN",
    setUp: "将这台平板设置为员工 PIN 平板",
    addDish: "添加这道菜",
    saveRules: "保存规则",
    addSection: "添加分区",
    open: "查看",
    manage: "查看与管理",
    cancel: "取消",
    updated: /^已更新 \d\d:\d\d$/u,
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Menus (CAT-MENU-LIST): New dish is the one accent fill; New combo and New section accent words.
const sellable = (n: number, name: string, nameZh: string, priceMinor: string) => ({
  skuReference: id(n),
  skuCode: "SKU_" + n,
  productName: name,
  productNameZh: nameZh,
  sizeName: name,
  active: true,
  priceMinor,
  offeredHere: true,
});
const builder = () => ({
  screenId: "CAT-MENU-BUILDER",
  sourceAsOf: at(),
  viewer: id(50),
  permissions: {
    mayRead: true,
    mayEdit: true,
    maySubmit: true,
    mayApprove: true,
    mayPublish: true,
  },
  menus: [],
  menu: {
    menuReference: id(1),
    internalCode: "MAIN",
    aggregateVersion: 3,
    versionReference: id(2),
    name: "TEST menu",
    storeReferences: [store],
    channelCodes: ["CUSTOMER_PWA"],
    orderTypeCodes: ["DINE_IN"],
    sections: [
      {
        sectionReference: id(10),
        code: "NOODLE",
        name: "Noodles (TEST)",
        nameZh: "面",
        items: [30, 31].map((n) => ({
          placementReference: id(200 + n),
          skuReference: id(n),
          featured: false,
        })),
      },
    ],
  },
  publication: null,
  latestRelease: null,
  listingStep: "Listed",
  submittedBy: null,
  soleOperator: null,
  sellables: [
    sellable(30, "Beef noodles (TEST)", "牛肉面", "1250"),
    sellable(31, "Zhajiang noodles (TEST)", "炸酱面", "1100"),
  ],
  mayOfferHere: true,
  allergenRegistry: false,
  customerView: null,
});
async function menus(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/commerce/one-store-combos/query", (route) =>
    route.fulfill({ headers, json: { combos: [] } }),
  );
  await page.route("**/merchant/commerce/menus/query", (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    if (body.menuReference !== null) return route.fulfill({ headers, json: builder() });
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-LIST",
        sourceAsOf: at(),
        viewer: id(50),
        permissions: builder().permissions,
        menus: [
          {
            menuReference: id(1),
            internalCode: "MAIN",
            aggregateVersion: 3,
            currentVersionReference: id(2),
            localizedNames: { "en-CA": "TEST menu" },
            placements: 2,
            publication: null,
            latestRelease: null,
          },
        ],
      },
    });
  });
  await page.route("**/merchant/commerce/availability/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf: at(),
        viewer: id(50),
        timeZone: scope.timeZone,
        permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
        items: [30, 31].map((n) => ({
          skuReference: id(n),
          skuCode: "SKU_" + n,
          productName: "x",
          sizeName: "x",
          status: "Available",
          soldOutUntil: null,
        })),
      },
    }),
  );
  await page.goto("/app/commerce/menus");
}

// Shared tablets & PINs (IAM-SESSION-LIST).
const devices = {
  thisDevice: null,
  devices: [
    {
      device: "dev-front",
      label: "Front counter (TEST)",
      registeredAt: "2026-11-02T14:00:00.000Z",
      registeredBy: "You",
      lastUsedAt: "2026-11-24T21:10:00.000Z",
    },
  ],
  staffPins: [
    {
      staff: "staff-ana",
      name: "Ana Lopez (TEST)",
      state: "Set",
      changedAt: "2026-11-01T15:00:00.000Z",
      lockedUntil: null,
    },
    {
      staff: "staff-ben",
      name: "Ben Ito (TEST)",
      state: "NotSet",
      changedAt: null,
      lockedUntil: null,
    },
  ],
};
async function sharedTablets(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers,
      json: {
        pin: { state: "Set", changedAt: "2026-10-01T15:00:00.000Z", lockedUntil: null },
        signIn: "Account",
        verifiedUntil: null,
      },
    }),
  );
  await page.route("**/merchant/store-devices", (route) =>
    route.fulfill({ headers, json: devices }),
  );
  await page.goto("/app/organization/sessions");
}

// Points (LOY-PROGRAM-LIST).
async function points(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/member-points", (route) =>
    route.fulfill({
      headers,
      json: {
        canManage: true,
        dishChoices: [
          { productReference: id(21), displayName: "Soup (TEST) 例汤" },
          { productReference: id(22), displayName: "Spring rolls (TEST) 春卷" },
        ],
        offeredHere: true,
        rule: {
          version: 0,
          earnPointsPerDollar: 3,
          redeemPointsPerDollar: 100,
          minimumRedemptionPoints: 300,
          redemptionIncrementPoints: 100,
          inactivityExpiryDays: 548,
          expiryNoticeDays: 30,
          rewards: [{ productReference: id(21), displayName: "Soup (TEST) 例汤", pointsCost: 500 }],
        },
        members: [],
        report: {
          members: 0,
          issuedPoints: 0,
          usedPoints: 0,
          returnedPoints: 0,
          reversedPoints: 0,
          expiredPoints: 0,
          forfeitedPoints: 0,
          outstandingPoints: 0,
          owedPoints: 0,
          usedValueMinor: "0",
        },
      },
    }),
  );
  await page.goto("/app/customers/loyalty-programs");
}

// Store features (STORE-CAPABILITY).
async function storeFeatures(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/store/kitchen-statement", (route) =>
    route.fulfill({
      headers,
      json: {
        status: "Current",
        statement: null,
        allergenChoices: [{ code: "PEANUT", name: "Peanuts", nameZh: "花生" }],
      },
    }),
  );
  await page.route("**/merchant/store/features", (route) =>
    route.fulfill({
      headers,
      json: {
        version: 0,
        templateCode: null,
        modules: {
          counterOrder: true,
          pickup: true,
          inventory: false,
          loyalty: false,
          alcohol: false,
        },
        changedAt: null,
        services: {
          version: 0,
          staffCall: false,
          chaseDish: false,
          askPartySize: false,
          changedAt: null,
        },
        teaCharge: { version: 0, teaSellableReference: null, changedAt: null },
        teaChoices: [],
        tips: {
          version: 0,
          enabled: true,
          tierPercents: [10, 15, 18],
          changedAt: null,
          offInStoreSetup: false,
        },
        autoAccept: { version: 0, pickup: false, dineIn: false, changedAt: null },
        canChange: true,
      },
    }),
  );
  await page.route("**/merchant/commerce/kitchen-sections/command", (route) =>
    route.fulfill({
      headers,
      json: { version: 1, sections: [{ sectionReference: id(40), name: "Wok (TEST)" }] },
    }),
  );
  await page.goto(`/app/organization/stores/${store}/capabilities`);
}

// Staff (IAM-USER-LIST, IAM-USER-DETAIL) and Roles (IAM-ROLE-LIST).
const member = (n: number, name: string) => ({
  actorReference: id(n),
  displayName: name,
  label: name,
  self: false,
  membershipStatus: "Active",
  storeAssignmentStatus: "Active",
  profileVersion: 1,
  assignments: [],
  pending: [],
  mayRequest: true,
  mayRename: true,
  mayRemove: true,
});
async function staff(page: Page, language: Language, detail = false) {
  await frame(page, language);
  await page.route("**/merchant/organization/staff/query", (route) => {
    const one =
      (route.request().postDataJSON() as { actorReference: string | null }).actorReference !== null;
    return route.fulfill({
      headers,
      json: {
        screenId: one ? "IAM-USER-DETAIL" : "IAM-USER-LIST",
        sourceAsOf: at(),
        viewer: {
          mayManage: false,
          mayApprove: false,
          brandMayManage: false,
          brandMayApprove: false,
          mayInvite: false,
        },
        roles: [
          { roleReference: id(50), code: "STORE_STAFF", name: "Counter staff", scope: "Store" },
        ],
        staff: one
          ? [member(61, "Ana Lopez (TEST)")]
          : [member(61, "Ana Lopez (TEST)"), member(62, "Ben Ito (TEST)")],
      },
    });
  });
  await page.goto(detail ? `/app/organization/users/${id(61)}` : "/app/organization/users");
}
const role = (n: number, name: string) => ({
  roleReference: id(n),
  name,
  description: "Orders, tables and payments",
  scope: "Store",
  version: 3,
  kind: "Preset",
  locked: false,
  state: "InUse",
  memberCount: 3,
  waitingAssignments: 0,
  permissions: ["merchant.access"],
  retiredByBop: 0,
  presetUpdate: null,
  change: null,
  lastOutcome: null,
  operations: ["Revise", "Duplicate"],
  history: [],
});
async function roles(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/organization/roles/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "IAM-ROLE-LIST",
        sourceAsOf: at(),
        freshness: "Fresh",
        completeness: "Complete",
        roles: [role(71, "Front of House"), role(72, "Kitchen"), role(73, "Store Manager")],
        mayManage: false,
        catalog: [],
      },
    }),
  );
  await page.goto("/app/organization/roles");
}

// Allergens (CMP-ALLERGEN-REVIEW, CMP-ALLERGEN-ITEM).
const ingredient = {
  itemReference: id(81),
  itemVersionReference: id(82),
  internalCode: "FLOUR",
  name: "Wheat flour (TEST)",
  unitCode: "KG",
  status: "Missing",
  declaration: null,
};
async function allergens(page: Page, language: Language, detail = false) {
  await frame(page, language);
  await page.route("**/merchant/compliance/allergens/query", (route) => {
    const one =
      (route.request().postDataJSON() as { itemReference: string | null }).itemReference !== null;
    return route.fulfill({
      headers,
      json: {
        screenId: one ? "CMP-ALLERGEN-ITEM" : "CMP-ALLERGEN-REVIEW",
        sourceAsOf: at(),
        viewer: id(50),
        permissions: { mayRead: true, mayDeclare: false, mayManageRegistry: false },
        locale: language === "en" ? "en-CA" : "zh-CN",
        registryProposal: null,
        soleOperator: null,
        registry: null,
        registryTemplate: {
          template: "CA_PRIORITY_TEST",
          jurisdictionCode: "CA",
          policyDocument: "TEST-ONLY synthetic list.",
          allergens: [{ code: "MILK", name: "Milk" }],
        },
        sources: ["SupplierSpecification"],
        ...(one ? { item: ingredient, history: [] } : { items: [ingredient] }),
      },
    });
  });
  await page.goto(detail ? `/app/compliance/allergens/${id(81)}` : "/app/compliance/allergens");
}

// Tasks (TASK-INBOX).
async function tasks(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/tasks", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "TASK-INBOX",
        storeLabel: scope.storeLabel,
        observedAt: at(),
        items: [],
        nextAfterTaskReference: null,
      },
    }),
  );
  await page.goto("/app/tasks");
}

for (const language of ["en", "zh-Hans"] as const) {
  const said = words[language];
  for (const [width, height] of sizes) {
    test(`@production F22 Menus: New dish is the one accent fill, the rest accent words, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await menus(page, language);
      const add = page.locator(".one-menu__add");
      await expect(add.getByRole("button", { name: said.newDish })).toBeVisible();
      await expectFill(add.getByRole("button", { name: said.newDish }));
      await expectWords(add.getByRole("button", { name: said.newSection }));
      expect(await fills(page, ".one-menu__add")).toBe(1);
      await noSideScroll(page);
    });

    test(`@production F22 Menus: New combo is accent words beside New dish, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await menus(page, language);
      const combo = page.locator(".one-menu__add").getByRole("button", { name: said.newCombo });
      await expect(combo).toBeVisible();
      await expectWords(combo);
    });

    test(`@production F22 Shared tablets & PINs: Refresh words, Remove and Reset PIN red words that ask first, Set up the one fill, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await sharedTablets(page, language);
      const main = page.locator("main.store-devices");
      await expect(main.getByRole("button", { name: said.setUp })).toBeVisible();
      await expectWords(
        page.locator(".workspace-page__header").getByRole("button", { name: said.refresh }),
      );
      await expectFill(main.getByRole("button", { name: said.setUp }));
      const remove = main.locator("table").first().getByRole("button", { name: said.remove });
      const reset = main.locator("table").nth(1).getByRole("button", { name: /PIN/u });
      await expectWords(remove, danger);
      await expectWords(reset.first(), danger);
      expect(await fills(page, "main.store-devices")).toBe(1);
      // Red words never act at once: each asks first, and Cancel is accent words.
      await remove.click();
      const ask = page.locator("dialog.store-devices__confirm");
      await expect(ask).toBeVisible();
      await expectWords(ask.getByRole("button", { name: said.cancel }));
      await ask.getByRole("button", { name: said.cancel }).click();
      await expect(ask).toBeHidden();
      await reset.first().click();
      await expect(ask).toBeVisible();
      await ask.getByRole("button", { name: said.cancel }).click();
      await noSideScroll(page);
    });

    test(`@production F22 Points: Remove and Add this dish words, Save rules the one fill, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await points(page, language);
      const main = page.locator("main.workspace-page");
      await expect(main.getByRole("button", { name: said.saveRules })).toBeVisible();
      await expectWords(main.getByRole("button", { name: said.remove, exact: false }).first());
      // Words that can be pressed: a dish and its points chosen.
      const add = main.getByRole("group", {
        name: language === "en" ? "Add a dish" : "添加一道菜",
      });
      await add.getByRole("combobox").selectOption({ index: 1 });
      await add.getByRole("spinbutton").fill("400");
      await expectWords(main.getByRole("button", { name: said.addDish }));
      await expectFill(main.getByRole("button", { name: said.saveRules }));
      await noSideScroll(page);
    });

    test(`@production F22 Store features: Add section is accent words, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await storeFeatures(page, language);
      const row = page.locator(".store-kitchen-sections__add");
      const add = row.getByRole("button", { name: said.addSection });
      await expect(add).toBeVisible();
      // Grey while there is no name; accent words once one is typed.
      await expectWords(add, "rgb(102, 102, 102)");
      await row.getByRole("textbox").fill("Steamer (TEST)");
      await expectWords(add);
      await noSideScroll(page);
    });

    test(`@production RA-16 Roles: Open is an accent 14/400 link and the rows have visible hairlines, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await roles(page, language);
      const rows = page.locator("li.role-row");
      await expect(rows).toHaveCount(3);
      const open = rows.first().getByRole("link", { name: said.open });
      expect(await look(open)).toMatchObject({
        color: accent,
        size: "14px",
        weight: "400",
        underline: "none",
      });
      // A drawn 1px #E5E5E5 hairline between rows (quiet.css: never above the first or below the
      // last), the full width of the list.
      const lines = await rows.evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return {
            top:
              style.borderTopWidth === "0px"
                ? "none"
                : [style.borderTopWidth, style.borderTopStyle, style.borderTopColor].join(" "),
            bottom: style.borderBottomWidth,
            span: node.getBoundingClientRect().width,
          };
        }),
      );
      expect(lines.map((line) => line.top)).toEqual([
        "none",
        `1px solid ${hairline}`,
        `1px solid ${hairline}`,
      ]);
      expect(lines.map((line) => line.bottom)).toEqual(["0px", "0px", "0px"]);
      for (const line of lines) expect(line.span).toBeGreaterThan(200);
      await noSideScroll(page);
    });

    test(`@production RA-16 Staff: View and manage is an accent 14/400 link, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await staff(page, language);
      const manage = page.getByRole("link", { name: said.manage }).first();
      await expect(manage).toBeVisible();
      expect(await look(manage)).toMatchObject({
        color: accent,
        size: "14px",
        weight: "400",
        underline: "none",
      });
      await noSideScroll(page);
    });
  }
}

/**
 * RA-03: Staff, Roles, Allergens (list and ingredient) and Tasks use the shared page header. At
 * 1440 the title row runs the full width and ends with the language switch, and "Updated hh:mm"
 * is in the header; at 1024 the stamp and the language are in the top bar (Figma 58:65); on a phone
 * the language is in the top bar and the stamp stays under the title.
 */
const headerPages = [
  { name: "Staff", open: (page: Page, language: Language) => staff(page, language) },
  { name: "Staff member", open: (page: Page, language: Language) => staff(page, language, true) },
  { name: "Roles", open: roles },
  { name: "Allergens", open: (page: Page, language: Language) => allergens(page, language) },
  {
    name: "Allergen ingredient",
    open: (page: Page, language: Language) => allergens(page, language, true),
  },
  { name: "Tasks", open: tasks },
] as const;

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    for (const screen of headerPages)
      test(`@production RA-03 ${screen.name} has the shared header, ${language} at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await screen.open(page, language);
        const h1 = page.locator("main.workspace-page .workspace-page__title h1");
        await expect(h1).toBeVisible();
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        expect(
          await h1.evaluate((node) => [
            getComputedStyle(node).fontSize,
            getComputedStyle(node).fontWeight,
          ]),
        ).toEqual(["28px", "600"]);
        const said = words[language];
        const headerStamp = page.locator(".workspace-page__header .workspace-page__freshness");
        const barStamp = page.locator(".workspace-sidebar__status .workspace-page__freshness");
        if (width === 1440) {
          const switchBox = await page
            .locator(".workspace-page__header .workspace-page__language")
            .evaluate((node) => node.getBoundingClientRect().right);
          expect(switchBox).toBeGreaterThanOrEqual(width - 64);
          await expect(headerStamp).toHaveText(said.updated);
        } else {
          await expect(page.locator("button.workspace-sidebar__language")).toBeVisible();
          await expect(
            page.locator(".workspace-page__header .workspace-page__language"),
          ).toBeHidden();
          if (width === 1024) {
            await expect(barStamp).toHaveText(said.updated);
            await expect(headerStamp).toHaveCount(0);
          } else await expect(headerStamp).toHaveText(said.updated);
        }
        // The title starts below the top bar, never under it.
        if (width !== 1440) {
          const bar = await page
            .locator(".workspace-sidebar")
            .evaluate((node) => node.getBoundingClientRect().bottom);
          expect(
            await h1.evaluate((node) => node.getBoundingClientRect().top),
          ).toBeGreaterThanOrEqual(bar);
        }
        await noSideScroll(page);
      });
