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
