import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { expect, it } from "vitest";
import {
  CHINESE_LOCALE,
  LanguageRoot,
  LanguageSwitch,
  initialLanguage,
  keepWords,
  menuLocale,
  saidTable,
  t,
  tWords,
  withNameLocale,
} from "./i18n.js";
import { zhHans } from "./zh-Hans.js";

const root = join(import.meta.dirname, "..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/u.test(name) && !/\.test\.|\.fixture\./u.test(name) ? [path] : [];
  });
}
/** Every English text the customer app passes to t(), and any call whose text is not literal. */
function translatedTexts(under: string = root) {
  const keys = new Set<string>();
  const dynamic: string[] = [];
  for (const file of sources(under)) {
    if (file.includes(`${join("src", "i18n")}`)) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      // tWords is t with Chinese short words kept whole across line breaks (batch 49).
      if (ts.isCallExpression(node) && ["t", "tWords"].includes(node.expression.getText())) {
        const text = node.arguments[0];
        if (text && (ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text)))
          keys.add(text.text);
        else dynamic.push(`${file}:${String(source.getLineAndCharacterOfPosition(node.pos).line)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys, dynamic };
}

it("Owner 2026-10-23: every customer text has its Simplified Chinese wording, with the same values", () => {
  const { keys, dynamic } = translatedTexts();
  expect(keys.size).toBeGreaterThan(800);
  // A text built at run time could never be found in the dictionary.
  expect(dynamic).toEqual([]);
  const missing = [...keys].filter((key) => !Object.hasOwn(zhHans, key));
  expect(missing).toEqual([]);
  const placeholders = (text: string) => new Set(text.match(/\{[A-Za-z][A-Za-z0-9]*\}/gu) ?? []);
  for (const [english, chinese] of Object.entries(zhHans)) {
    const allowed = placeholders(english);
    for (const name of placeholders(chinese))
      expect(allowed.has(name), `${english} → ${name}`).toBe(true);
    expect(chinese.trim(), english).not.toBe("");
  }
});

it("chooses Chinese for a device that prefers Chinese, and asks the menu in Simplified Chinese", () => {
  expect(initialLanguage(["zh-CN", "en"])).toBe("zh-Hans");
  expect(initialLanguage(["zh-HK"])).toBe("zh-Hans");
  expect(initialLanguage(["en-CA", "zh-CN"])).toBe("en");
  expect(initialLanguage([])).toBe("en");
  expect(menuLocale("zh-Hans", "en-CA")).toBe(CHINESE_LOCALE);
  expect(menuLocale("en", "fr-CA")).toBe("fr-CA");
});

it("fills values into the English text when English is chosen", () => {
  expect(t("Order {orderNumber}", { orderNumber: "12" })).toBe("Order 12");
  expect(t("Not a known text")).toBe("Not a known text");
  // A value ending with a period ("8:08 a.m.") stands in for the sentence's own period.
  expect(t("A staff member saw your request at {time}.", { time: "8:08 a.m." })).toBe(
    "A staff member saw your request at 8:08 a.m.",
  );
  expect(t("A staff member saw your request at {time}.", { time: "20:08" })).toBe(
    "A staff member saw your request at 20:08.",
  );
  expect(t("Wait{dots}...", { dots: "." })).toBe("Wait....");
});

it("renders the whole page in Chinese once Chinese is chosen, with a switch back to English", () => {
  const html = renderToStaticMarkup(
    createElement(LanguageRoot, {
      initial: "zh-Hans",
      children: () =>
        createElement(
          "p",
          null,
          t("Your cart"),
          " · ",
          t("Order {orderNumber}", { orderNumber: "7" }),
        ),
    }),
  );
  expect(html).toContain("您的购物车 · 订单 7");
  const toggle = renderToStaticMarkup(
    createElement(LanguageRoot, {
      initial: "zh-Hans",
      children: () => createElement(LanguageSwitch),
    }),
  );
  expect(toggle).toContain(">English</button>");
  expect(toggle).toContain('aria-label="Switch to English"');
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
  expect(t("Your cart")).toBe("Your cart");
});

it("Owner 2026-10-23: asks the Store's item names in Chinese only while Chinese is chosen", () => {
  try {
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
    expect(withNameLocale("/bff/customer/cart")).toBe("/bff/customer/cart?locale=zh-Hans-CA");
    expect(withNameLocale("/api/v1/x?a=1")).toBe("/api/v1/x?a=1&locale=zh-Hans-CA");
  } finally {
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
  }
  expect(withNameLocale("/bff/customer/cart")).toBe("/bff/customer/cart");
});

// Batch 42 (v15 b41 live): the waiting page said 您 and the table page 你 in one visit. Every guest
// text speaks to the guest one way, politely (您), as the Owner's brief does (this replaces b28's
// "你 everywhere", taken when most texts said 你).
it("batch 42 (v15 b41 live): every Chinese guest text says 您, never 你", () => {
  const informal = Object.entries(zhHans).filter(([, chinese]) => chinese.includes("你"));
  expect(informal).toEqual([]);
  expect(zhHans["Your table"]).toBe("您的桌位");
  expect(
    zhHans[
      "We use your phone number only to text you a sign-in code and to tell you before your points expire. You can leave and delete it any time."
    ],
  ).toBe("手机号只用来发登录验证码，以及在积分过期前通知您。您可以随时退出并删除。");
});

it("batch 42 (v15 b41 live): a table named in Latin letters keeps a space where it meets Chinese", () => {
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
  try {
    // Live: "Test Merchant 2 Main - not production 的L41V A (TEST) 还没开台".
    expect(
      t("Table {table} at {storeDisplayName} isn’t open yet", {
        table: saidTable("L41V A (TEST)"),
        storeDisplayName: "Test Merchant 2 Main - not production",
      }),
    ).toBe("Test Merchant 2 Main - not production 的 L41V A (TEST) 还没开台");
    expect(
      t("Not sitting at table {table}? Tell staff, so they can give you the code for your table.", {
        table: saidTable("L41V A (TEST)"),
      }),
    ).toBe("您坐的不是 L41V A (TEST)？请告诉店员，换成您这桌的二维码。");
    // A table moved between two named tables: a space on both sides of each name.
    expect(
      t(
        "Staff moved your party from table {from} to table {table}. Keep ordering and paying on this phone.",
        { from: saidTable("Patio"), table: saidTable("Window") },
      ),
    ).toBe("店员已把您从 Patio 换到 Window，继续用这部手机点餐和付款即可。");
    // A numbered table keeps its word; a Chinese name gets no extra space.
    expect(
      t("Table {table} at {storeDisplayName} isn’t open yet", {
        table: saidTable("12"),
        storeDisplayName: "面馆",
      }),
    ).toBe("面馆 的桌号 12 还没开台");
    expect(
      t("Table {table} at {storeDisplayName} isn’t open yet", {
        table: saidTable("包间"),
        storeDisplayName: "面馆",
      }),
    ).toBe("面馆 的包间还没开台");
  } finally {
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
  }
  expect(
    t("Table {table} at {storeDisplayName} isn’t open yet", {
      table: saidTable("L41V A (TEST)"),
      storeDisplayName: "Noodle Bar",
    }),
  ).toBe("L41V A (TEST) at Noodle Bar isn’t open yet");
});

it("batch 40 (v15 cross-midnight): Chinese sentences end with “。”, never an ASCII period", async () => {
  // "厨房 0:30 已停止接单." and "今天 12:00 开门." were seen live: a sentence finished in code.
  const cjk = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]\.(?!\.)/u;
  const afterValue = /\}\.(?:\s|$)/u;
  const ascii = Object.entries(zhHans).filter(
    ([, chinese]) =>
      cjk.test(chinese) || (afterValue.test(chinese) && /[\u3400-\u9fff]/u.test(chinese)),
  );
  expect(ascii).toEqual([]);
  // A value given to t() is a part of the sentence: the sentence's own words end it.
  const finished: string[] = [];
  for (const file of sources(root)) {
    if (file.includes(`${join("src", "i18n")}`)) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node, inValues: boolean): void => {
      if (inValues && ts.isCallExpression(node) && node.expression.getText() === "endSentence")
        finished.push(`${file}:${String(source.getLineAndCharacterOfPosition(node.pos).line + 1)}`);
      const values =
        ts.isCallExpression(node) && ["t", "tWords"].includes(node.expression.getText())
          ? node.arguments[1]
          : null;
      ts.forEachChild(node, (child) => visit(child, inValues || child === values));
    };
    visit(source, false);
  }
  expect(finished).toEqual([]);
  const { endSentence } = await import("../journey/format.js");
  const { storeServiceNoticeText } = await import("../store/StoreIdentity.js");
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
  try {
    expect(endSentence("今天 12:00 开门")).toBe("今天 12:00 开门。");
    expect(endSentence("好了！")).toBe("好了！");
    const hours = {
      status: "Open" as const,
      todayHours: [{ startLocalTime: "12:00:00", endLocalTime: "01:00:00", endsNextDay: true }],
      closesAt: "01:00:00",
      opensAt: null,
      localDate: "2026-11-21",
      todayKind: null,
      lastOrdersAt: "00:30:00",
      pausedUntil: null,
      ordersStopped: true,
      nextOpening: { localDate: "2026-11-21", startLocalTime: "12:00:00" },
      tonight: { startLocalTime: "12:00:00", endLocalTime: "01:00:00" },
      upcoming: [],
    };
    const texts = [
      storeServiceNoticeText(hours, "Stopped", null, "Pickup"),
      storeServiceNoticeText(hours, "Stopped", null, "DineIn"),
      storeServiceNoticeText({ ...hours, status: "Closed" }, "Closed", null, "Pickup"),
    ].flatMap((text) => [text?.headline ?? "", text?.detail ?? ""]);
    expect(texts[0]).toBe("厨房 0:30 已停止接单。");
    expect(texts[4]).toBe("线上自取现已停止接单。");
    for (const text of texts) expect(text).not.toMatch(cjk);
    expect(t("This round will be cancelled at {value1}. ", { value1: "21:46" })).toBe(
      "这一轮将于 21:46 取消。",
    );
    expect(
      t("It will be cancelled at {time}. Ask a staff member if you need help.", { time: "21:46" }),
    ).not.toMatch(/21:46\./u);
  } finally {
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
  }
  expect(t("This round will be cancelled at {value1}. ", { value1: "9:46 p.m." })).toBe(
    "This round will be cancelled at 9:46 p.m. ",
  );
  expect(t("This round will be cancelled at {value1}. ", { value1: "21:46" })).toBe(
    "This round will be cancelled at 21:46. ",
  );
});

// Batch 46 (v15 b45 live, b-merged-G4-390.png): the merged page wrote "请扫 E45 A (TEST)的桌台二维码"
// (no space: the name ends in ")") while the empty-close card wrote "E45 A (TEST) 没有点单". One
// rule now: a half-width edge of a name meets Chinese text with one space, a Chinese name with
// none (whatever space the sentence had), full-width punctuation with none.
it("batch 46 (v15 b45 live): one spacing rule around a table name in every Chinese dining sentence", () => {
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
  try {
    const merged = (label: string) =>
      t(
        "Staff joined your party to table {table}. Everything your table ordered is on that table's bill. Scan the code on table {table} to keep ordering and paying together.",
        { table: saidTable(label) },
      );
    expect(merged("E45 A (TEST)")).toBe(
      "店员已把您并到 E45 A (TEST)，您点过的菜都在那桌的账单上。请扫 E45 A (TEST) 的桌台二维码继续点餐和一起付款。",
    );
    expect(merged("包间")).toBe(
      "店员已把您并到包间，您点过的菜都在那桌的账单上。请扫包间的桌台二维码继续点餐和一起付款。",
    );
    expect(merged("12")).toBe(
      "店员已把您并到 12 桌，您点过的菜都在那桌的账单上。请扫 12 桌的桌台二维码继续点餐和一起付款。",
    );
    const empty = (label: string) =>
      t("Nothing was ordered at table {table}, so nothing was charged.", {
        table: saidTable(label),
      });
    expect(empty("E45 A (TEST)")).toBe("E45 A (TEST) 没有点单，所以没有扣款。");
    expect(empty("包间")).toBe("包间没有点单，所以没有扣款。");
    expect(t("Your meal at table {table} has ended.", { table: saidTable("E45 A (TEST)") })).toBe(
      "E45 A (TEST) 的用餐已结束。",
    );
    expect(t("Your table moved to table {table}", { table: saidTable("E45 A (TEST)") })).toBe(
      "您这桌已换到 E45 A (TEST)",
    );
  } finally {
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
  }
  // English keeps the sentence's own spaces.
  expect(
    t("Nothing was ordered at table {table}, so nothing was charged.", {
      table: saidTable("E45 A (TEST)"),
    }),
  ).toBe("Nothing was ordered at E45 A (TEST), so nothing was charged.");
});

// Batch 49 (v15 b48 live, 390 px zh-Hans): "…Lane Dessert (TEST) 自" / "取。" split a two-character
// word. Short Chinese words next to a name are kept whole; the words read the same.
it("keeps short Chinese words around a name whole, and leaves English as it is", () => {
  const zh = (render: () => unknown) =>
    renderToStaticMarkup(
      createElement(LanguageRoot, {
        initial: "zh-Hans",
        children: () => createElement("p", null, render() as string),
      }),
    );
  try {
    const pickup = zh(() =>
      tWords("Pickup from {storeDisplayName} is selected.", {
        storeDisplayName: "巷口糖水 Lane Dessert (TEST)",
      }),
    );
    expect(pickup).toContain('<span class="zh-word">自取。</span>');
    expect(pickup.replace(/<[^>]+>/gu, "")).toBe("已选择在巷口糖水 Lane Dessert (TEST) 自取。");
    expect(
      zh(() => tWords("{store} takes dine-in orders only", { store: "Half Sugar Tea" })),
    ).toContain('<span class="zh-word">只做堂食</span>');
    // A longer run is kept word by word, so the line can still break inside it.
    const ended = zh(() =>
      tWords("Your meal at table {table} has ended.", { table: saidTable("G48 C (TEST)") }),
    );
    expect(ended.replace(/<[^>]+>/gu, "")).toBe("G48 C (TEST) 的用餐已结束。");
    expect(ended).toMatch(/<span class="zh-word">结束。<\/span>/u);
    expect(ended).not.toContain('<span class="zh-word">的用餐已结束。</span>');
    // One Chinese character alone needs nothing.
    expect(zh(() => keepWords("A 好 B"))).toBe("<p>A 好 B</p>");
  } finally {
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
  }
  expect(keepWords("Pickup from Lane Dessert is selected.")).toBe(
    "Pickup from Lane Dessert is selected.",
  );
});
