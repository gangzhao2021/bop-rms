import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import {
  countOf,
  displayLocale,
  initialLanguage,
  listSeparator,
  setLanguageForTest,
  t,
  withContentLocale,
  withNameLocale,
} from "./i18n.js";
import { zhHans } from "./zh-Hans.js";
import { GROUP_LABELS } from "../WorkspaceLayout.js";
import {
  brandRoleTemplateProfiles,
  storePermissionCatalog,
  storeRoleTemplateProfiles,
} from "../../../../packages/bop/permission/src/catalog/store-permission-catalog.js";

afterEach(() => setLanguageForTest("en"));

const root = join(import.meta.dirname, "..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/u.test(name) && !/\.test\.|\.fixture\./u.test(name) ? [path] : [];
  });
}
const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
/** Texts the staff screens show through `t()` but compute at run time (from a fixed list). */
const DYNAMIC = ["WorkspaceLayout.tsx"];

function translatedTexts() {
  const keys = new Set<string>();
  const dynamic: string[] = [];
  for (const file of sources(root)) {
    if (file.includes(join("src", "i18n"))) continue;
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "t") {
        const text = node.arguments[0];
        if (text && (ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text)))
          keys.add(text.text);
        else if (!DYNAMIC.some((name) => file.endsWith(name)))
          dynamic.push(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys, dynamic };
}

it("Owner 2026-10-24: every staff text has its Simplified Chinese wording, with the same values", () => {
  const { keys, dynamic } = translatedTexts();
  expect(keys.size).toBeGreaterThan(3500);
  // A text built at run time could never be found in the dictionary.
  expect(dynamic).toEqual([]);
  // The workspace navigation: group headings here, screen labels from the pilot server.
  const navigation = readFileSync(
    join(root, "../../../tooling/environment/pilot-merchant.mjs"),
    "utf8",
  );
  for (const match of navigation.matchAll(/label: "([^"]+)"/gu)) keys.add(match[1] as string);
  for (const label of Object.values(GROUP_LABELS)) keys.add(label);
  // Built-in role names and descriptions and permission descriptions the server sends.
  for (const entry of storePermissionCatalog()) keys.add(entry.description);
  for (const profile of [
    ...Object.values(storeRoleTemplateProfiles),
    ...Object.values(brandRoleTemplateProfiles),
  ]) {
    keys.add(profile.displayName);
    keys.add(profile.description);
  }
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

it("leaves no plain English text in a translated screen", () => {
  const untranslated: string[] = [];
  for (const file of sources(root)) {
    const text = readFileSync(file, "utf8");
    if (!/from "\.{1,2}\/(?:\.\.\/)*i18n\/i18n\.js"/u.test(text)) continue;
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && /[A-Za-z]{2,}/u.test(node.text) && node.text.trim() !== "BOP")
        untranslated.push(`${file}: ${node.text.trim().slice(0, 60)}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(untranslated).toEqual([]);
});

it("chooses Chinese for a device that prefers Chinese, and writes Chinese while chosen", () => {
  expect(initialLanguage(["zh-CN", "en"])).toBe("zh-Hans");
  expect(initialLanguage(["en-CA", "zh-CN"])).toBe("en");
  expect(initialLanguage([])).toBe("en");
  expect(t("Orders")).toBe("Orders");
  expect(countOf(3, "order")).toBe("3 orders");
  expect(countOf(1, "order")).toBe("1 order");
  expect(withNameLocale("/merchant/orders")).toBe("/merchant/orders");
  expect(displayLocale()).toBe("en-US");
  setLanguageForTest("zh-Hans");
  expect(t("Orders")).toBe("订单");
  expect(t("Order {orderNumber}", { orderNumber: "12" })).toBe("订单 12");
  expect(countOf(3, "order")).toBe("3 笔订单");
  expect(listSeparator()).toBe("、");
  expect(displayLocale()).toBe("zh-CN");
  expect(withNameLocale("/merchant/orders?page=2")).toBe(
    "/merchant/orders?page=2&locale=zh-Hans-CA",
  );
});

it("asks /merchant reads for Store content in Chinese only while Chinese is chosen", async () => {
  const seen: (string | null)[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("x-bop-content-locale"));
    return new Response("{}");
  }) as typeof fetch;
  const origin = () => "https://pilot.example/operations/orders";
  const wrapped = withContentLocale(fetcher, origin);
  await wrapped("/merchant/orders", { headers: { accept: "application/json" } });
  setLanguageForTest("zh-Hans");
  await wrapped("/merchant/orders", { headers: { accept: "application/json" } });
  await wrapped("https://elsewhere.example/merchant/orders");
  await wrapped("/api/v1/other");
  expect(seen).toEqual([null, "zh-Hans-CA", null, null]);
});
