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

/**
 * Batch 64 (v15 batch 63 live, TM2): an order number was said three ways ("自取 · 35 号单" on the
 * kitchen ticket, "订单 36" on a table ticket, "订单 35 已付款" at the counter), and the kitchen two
 * ("记录后后厨才开始制作这一单" beside "记录后厨房才开始做这单"). One form each: "35 号单", 厨房.
 */
it("an order number reads one way on every staff screen: N 号单", () => {
  const numbered = /订单\s*\{(?!order\})\w+\}/u;
  expect(entries.filter(([, zh]) => numbered.test(zh)).map(([en]) => en)).toEqual([]);
  setLanguageForTest("zh-Hans");
  expect(t("Order {orderNumber}", { orderNumber: "36" })).toBe("36 号单");
  expect(t("Order {orderNumber} paid", { orderNumber: "35" })).toBe("35 号单已付款");
  expect(t("Order {orderNumber} · {amount}", { orderNumber: "35", amount: "$17.80" })).toBe(
    "35 号单 · $17.80",
  );
  expect(t("Pickup · Order {orderNumber}", { orderNumber: "35" })).toBe("自取 · 35 号单");
});

it("the kitchen has one name on every staff screen: 厨房", () => {
  // 后厨房 only where a sentence's 后 ("after") meets 厨房.
  expect(entries.filter(([, zh]) => /后厨(?!房)/u.test(zh)).map(([en]) => en)).toEqual([]);
  setLanguageForTest("zh-Hans");
  expect(t("Kitchen")).toBe("厨房");
  expect(
    t(
      "Charge {amount} on the card machine first, then record it here. The kitchen starts this order once it is recorded.",
      { amount: "$17.80" },
    ),
  ).toBe("请先在刷卡机上收款 $17.80，再在此记录。记录后厨房才开始制作这一单。");
});

/**
 * Batch 65 (v15 batch 64 live, TM2): the kitchen still built "桌台 K64 C · 订单 55" from a
 * " · Order " fragment, beside a ticket titled "55 号单"; Tonight's lines said "22 号 · …", the
 * handover button "交给顾客 · 12 号", the cancel question "取消 12 号订单？" and a paper order
 * "纸单 7：…". Every staff zh text with an order's number says it as "N 号单" (paper: "N 号纸质单").
 */
it("every staff text that carries an order's number says it as N 号单", () => {
  const wrong = entries.filter(([en, zh]) => {
    const placeholder = /(?<![Ll]ast )\b[Oo]rders? #?\{(\w+)\}/u.exec(en)?.[1];
    if (placeholder === undefined || placeholder === "order") return false; // {order} is an amount
    return !new RegExp(`\\{${placeholder}\\} 号(单|纸质单)`, "u").test(zh);
  });
  expect(wrong.map(([en]) => en)).toEqual([]);
  // No fragment to glue a number onto ("· 订单 " + 55).
  expect(entries.filter(([, zh]) => /订单\s+$/u.test(zh)).map(([en]) => en)).toEqual([]);
});

it("the kitchen names a ticket's order as its title does", async () => {
  const { kitchenOrderText } = await import("../kitchen-board.js");
  setLanguageForTest("zh-Hans");
  expect(kitchenOrderText({ orderNumber: "55", orderType: "DineIn", tableLabel: "T4" })).toBe(
    "桌台 T4 · 55 号单",
  );
  // A named table is said by its name alone.
  expect(kitchenOrderText({ orderNumber: "55", orderType: "DineIn", tableLabel: "K64 C" })).toBe(
    "K64 C · 55 号单",
  );
  expect(kitchenOrderText({ orderNumber: "5", orderType: "Pickup", tableLabel: null })).toBe(
    "自取 · 5 号单",
  );
  expect(kitchenOrderText({ orderNumber: "2", orderType: "DineIn", tableLabel: null })).toBe(
    "堂食 · 2 号单",
  );
  expect(t("Hand over to customer · Order {orderNumber}", { orderNumber: "12" })).toBe(
    "交给顾客 · 12 号单",
  );
  expect(t("Cancel order {orderNumber}?", { orderNumber: "12" })).toBe("取消 12 号单？");
  setLanguageForTest("en");
  expect(kitchenOrderText({ orderNumber: "55", orderType: "DineIn", tableLabel: "T4" })).toBe(
    "Table T4 · Order 55",
  );
});
