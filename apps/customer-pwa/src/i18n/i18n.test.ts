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
function translatedTexts() {
  const keys = new Set<string>();
  const dynamic: string[] = [];
  for (const file of sources(root)) {
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
