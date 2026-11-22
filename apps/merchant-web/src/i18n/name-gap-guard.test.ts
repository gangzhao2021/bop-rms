import { afterEach, expect, it } from "vitest";
import { setLanguageForTest, t } from "./i18n.js";
import { zhHans } from "./zh-Hans.js";

/**
 * Batch 46 (v15 overnight 45): a name or label filled into Chinese text has no space of its own
 * in the template, so a Chinese name meets the sentence directly ("可能含芝麻", "你批准"). Where a
 * Latin name meets Chinese, the v15 b12 rule still sets it off when the text is filled in; times,
 * numbers, amounts and a table's own label keep their spaces.
 */
const names = [
  "name",
  "item",
  "displayName",
  "label",
  "names",
  "store",
  "dish",
  "group",
  "productName",
  "setName",
  "sizeName",
  "merchant",
  "person",
  "approver",
  "reviewedBy",
  "by",
  "who",
  "choice",
  "requestedBy",
  "recordedBy",
  "submittedBy",
  "approvedBy",
  "authorLabel",
  "reviewerLabel",
  "fileName",
  "allergen",
  "allergens",
  "section",
  "list",
  "entry",
  "retiringEntry",
  "assigneeReference",
];
// "Table {label}" is a table's own label; " · Remade {item}×" counts dishes.
const notNames = new Set(["Table {label}", " · Remade {item}×"]);

afterEach(() => setLanguageForTest("en"));

it("no Chinese text puts a space between a filled-in name and a Chinese character", () => {
  const han = "[\\u3400-\\u9fff（）：，。“”「」]";
  const any = names.join("|");
  const spaced = new RegExp(`\\{(?:${any})\\} (?=${han})|(?<=${han}) \\{(?:${any})\\}`, "u");
  const found = Object.entries(zhHans)
    .filter(([english, chinese]) => !notNames.has(english) && spaced.test(chinese))
    .map(([english]) => english);
  expect(found).toEqual([]);
});

it("a Chinese name meets the sentence directly and a Latin one keeps the b12 space", () => {
  setLanguageForTest("zh-Hans");
  expect(t("may contain {allergen}", { allergen: "芝麻" })).toBe("可能含芝麻");
  expect(
    t("Asked by {name}, approved by {approver} · {at}", {
      name: "小王",
      approver: "你",
      at: "20:30",
    }),
  ).toBe("小王申请，你批准 · 20:30");
  expect(
    t("Asked by {name}, approved by {approver} · {at}", {
      name: "Mia",
      approver: "你",
      at: "20:30",
    }),
  ).toBe("Mia 申请，你批准 · 20:30");
});

/**
 * Batch 47 (v15 b46 live, guest "含有 花生、…"): the staff texts filled with a list or a name under
 * a generic placeholder ({value}, {dishes}, {from}, {marks}, {reason}) follow the same rule, so the
 * kitchen and dish screens read "含有花生、芝麻", never "含有 花生、芝麻".
 */
const filledWithNames: Readonly<Record<string, Record<string, string>>> = {
  "Contains {value}": { value: "花生、芝麻" },
  "May contain {value}": { value: "芝麻" },
  "Whole combo contains {value}": { value: "花生、芝麻" },
  "Whole combo may contain {value}": { value: "芝麻" },
  "Combo: {comboName} · also {dishes}": { comboName: "双人餐", dishes: "担担面、凉面" },
  "Without {from}": { from: "香菜" },
  "Reason {value}": { value: "牛肉" },
  "{marks} could not be set. Open the dish with Edit and set it.": { marks: "辣、素" },
  "Stopped at {item}. {reason} What was applied stays; try again to carry on.": {
    item: "担担面",
    reason: "这道菜已被别人改过。",
  },
  "{item} at {store}: the option {value} has no published recipe change for the recipe used there. Set, review and publish it under Option recipes, then list it again.":
    { item: "担担面", store: "面馆", value: "加辣" },
  "{text} The table's rounds and payments are on the Orders page.": {
    text: "这桌还有未付款的一轮。",
  },
};

it("a list or name filled into a staff text meets the Chinese around it directly", () => {
  setLanguageForTest("zh-Hans");
  const spaced = Object.entries(filledWithNames).filter(([english, values]) =>
    /[㐀-鿿（）：，。、] [㐀-鿿（）：，。、]/u.test(t(english, values)),
  );
  expect(spaced.map(([english, values]) => t(english, values))).toEqual([]);
  expect(t("Contains {value}", { value: "花生、芝麻" })).toBe("含有花生、芝麻");
  expect(t("May contain {value}", { value: "Sesame" })).toBe("可能含有 Sesame");
});
