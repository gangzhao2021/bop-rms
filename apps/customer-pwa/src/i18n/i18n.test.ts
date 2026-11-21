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
  menuLocale,
  t,
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
      if (ts.isCallExpression(node) && node.expression.getText() === "t") {
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
  expect(html).toContain("你的购物车 · 订单 7");
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

it("b28 (v15 live26): the points and sign-up texts say 你, as the rest of the guest page does", () => {
  const { keys } = translatedTexts(join(root, "member"));
  expect(keys.size).toBeGreaterThan(40);
  const formal = [...keys].filter((key) => (zhHans[key] ?? "").includes("您"));
  expect(formal).toEqual([]);
  expect(
    zhHans[
      "We use your phone number only to text you a sign-in code and to tell you before your points expire. You can leave and delete it any time."
    ],
  ).toBe("手机号只用来发登录验证码，以及在积分过期前通知你。你可以随时退出并删除。");
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
        ts.isCallExpression(node) && node.expression.getText() === "t" ? node.arguments[1] : null;
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
