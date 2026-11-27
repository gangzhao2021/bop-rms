import { afterEach, expect, it } from "vitest";
import { setLanguageForTest, t } from "./i18n/i18n.js";
import { staffLabel, stockReasonText, stockUnitName, unitText } from "./stock-reason-text.js";

afterEach(() => setLanguageForTest("en"));

it("WP-2423 D3: stock reasons and units read in the staff language, never as codes", () => {
  expect(stockReasonText("DROPPED")).toBe("Dropped or spilled");
  expect(stockReasonText("UNEXPLAINED")).toBe("Reason not known");
  expect(stockUnitName("KG", "Kilogram")).toBe("Kilogram");
  setLanguageForTest("zh-Hans");
  for (const [code, zh] of [
    ["EXPIRED", "已过期"],
    ["SPOILED", "变质"],
    ["DROPPED", "掉落或洒出"],
    ["ENTERED_IN_ERROR", "录入错误"],
    ["SHORT_DATED", "临近保质期"],
    ["THEFT_OR_LOSS", "丢失或被盗"],
    ["UNEXPLAINED", "原因不明"],
  ] as const)
    expect(stockReasonText(code), code).toBe(zh);
  expect(stockUnitName("KG", "Kilogram")).toBe("公斤");
  expect(stockUnitName("EA", "Each")).toBe("个");
  // The kitchen's remake reason "Dropped" is something that fell, not something given up.
  expect(t("Dropped")).toBe("掉落了");
  // A unit Inventory adds later shows the label it sent.
  expect(stockUnitName("TRAY", "Tray")).toBe("Tray");
});

it("WP-2423 M122 (v15 live check): a unit after a quantity and a person read in Chinese, not KG/L or You", () => {
  expect(unitText("KG")).toBe("kg");
  expect(unitText("L")).toBe("L");
  expect(unitText("kg")).toBe("kg");
  expect(staffLabel("You")).toBe("You");
  setLanguageForTest("zh-Hans");
  expect(unitText("KG")).toBe("公斤");
  expect(unitText("kg")).toBe("公斤");
  expect(unitText("L")).toBe("升");
  expect(unitText("ML")).toBe("毫升");
  expect(unitText("EACH")).toBe("个");
  expect(unitText("BOX")).toBe("box");
  expect(staffLabel("You")).toBe("你");
  expect(staffLabel(undefined)).toBe(t("Staff member"));
  expect(staffLabel("TEST Owner Two")).toBe("TEST Owner Two");
});
