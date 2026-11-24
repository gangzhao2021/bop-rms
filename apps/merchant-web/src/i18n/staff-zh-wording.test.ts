import { afterEach, expect, it } from "vitest";
import { setLanguageForTest, t } from "./i18n.js";
import { zhHans } from "./zh-Hans.js";

/**
 * Batch 58 (v15 batch 57 live, Test Merchant 2): staff Chinese said three things in two ways.
 * The table panel's split read "已付 1/2 份 · 还差 $14.12" while the guest's phone read
 * "2 份付了 1 份 · 还差 $14.12"; a refund line on Orders ended "4:09 经办你"; and Tables, Home
 * and the kitchen board named earlier days' leftovers 之前营业日 (or 往日, 是之前的) while Orders
 * said 较早营业日.
 */
afterEach(() => setLanguageForTest("en"));

const entries = Object.entries(zhHans);

it("no staff Chinese text says parts paid as a fraction", () => {
  const fraction = /已付\s*\{\w+\}\s*[/／]\s*\{\w+\}|已付\s*\d+\s*[/／]\s*\d+/u;
  expect(entries.filter(([, zh]) => fraction.test(zh)).map(([en]) => en)).toEqual([]);
});

it("parts paid read as on the guest's phone, in both places staff see them", () => {
  setLanguageForTest("zh-Hans");
  const args = { paid: "1", count: "2", amount: "$14.12" };
  expect(t("{paid} of {count} parts paid · {amount} to go", args)).toBe(
    "2 份付了 1 份 · 还差 $14.12",
  );
  expect(t("{amount} to go · {paid} of {count} parts paid", args)).toBe(
    "还差 $14.12 · 2 份付了 1 份",
  );
  setLanguageForTest("en");
  expect(t("{paid} of {count} parts paid · {amount} to go", args)).toBe(
    "1 of 2 parts paid · $14.12 to go",
  );
});

it("who did it reads as a sentence, for the signed-in person and for a name", () => {
  setLanguageForTest("zh-Hans");
  expect(t("{time} by {person}", { time: "4:09", person: t("You") })).toBe("4:09 由你经办");
  expect(t("{time} by {person}", { time: "4:09", person: "Mei" })).toBe("4:09 由 Mei 经办");
  expect(t("by {person}, {time}", { person: t("You"), time: "4:09" })).toBe("由你经办，4:09");
  // Never the actor straight after 经办 ("经办你"), nor a bare name before a time ("你 4:09").
  const bare = entries.filter(([, zh]) => /经办\{\w+\}|^\{person\} \{time\}$/u.test(zh));
  expect(bare.map(([en]) => en)).toEqual([]);
});

it("earlier days have one name on every staff screen: 较早营业日", () => {
  const old = /之前营业日|往日|较早的营业日|是之前的/u;
  expect(entries.filter(([, zh]) => old.test(zh)).map(([en]) => en)).toEqual([]);
  const named = entries.filter(([en]) => /\bearlier (business )?days?\b/iu.test(en));
  expect(named.length).toBeGreaterThan(30);
  expect(named.filter(([, zh]) => !zh.includes("较早营业日")).map(([en]) => en)).toEqual([]);
});

it("Tables, Home and the kitchen board use it, as Orders does", () => {
  setLanguageForTest("zh-Hans");
  expect(t("Tables still open from earlier days")).toBe("较早营业日没关的桌");
  expect(t("From earlier days")).toBe("较早营业日");
  expect(t("{tables} from earlier days", { tables: "1 张桌台" })).toBe("1 张桌台来自较早营业日");
  expect(t("Not counted: {tables} from earlier days", { tables: "8 张桌台" })).toBe(
    "不计入：8 张桌台来自较早营业日",
  );
  expect(t("· {count} more from earlier days", { count: 2 })).toBe("· 另有 2 张来自较早营业日");
  expect(t(" · {count} from earlier days", { count: 46 })).toBe(" · 另有 46 单来自较早营业日");
});
