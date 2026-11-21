import { expect, it } from "vitest";
import {
  actionAccessDeniedText,
  kitchenOnlyAccessDeniedText,
  kitchenOnlyNavigation,
  pageAccessDeniedText,
} from "./access-denied.js";
import { zhHans } from "./i18n/zh-Hans.js";

const item = (screenId: string) => ({ screenId });

it("batch 38: a kitchen display or a Kitchen role is kitchen work only; anyone with more is not", () => {
  // A kitchen display sign-in lists the kitchen alone; the Kitchen role adds recording waste.
  expect(kitchenOnlyNavigation([item("KIT-KITCHEN-QUEUE")])).toBe(true);
  expect(kitchenOnlyNavigation([item("KIT-KITCHEN-QUEUE"), item("INV-WASTE-RECORD")])).toBe(true);
  // A runner, a cashier, a manager, or nobody at all.
  expect(kitchenOnlyNavigation([item("KIT-KITCHEN-QUEUE"), item("DIN-FLOOR-BOARD")])).toBe(false);
  expect(kitchenOnlyNavigation([item("INV-WASTE-RECORD")])).toBe(false);
  expect(kitchenOnlyNavigation([])).toBe(false);
});

it("batch 38: every refusal says what to do next, in both languages, without internal words", () => {
  for (const text of [pageAccessDeniedText, actionAccessDeniedText, kitchenOnlyAccessDeniedText]) {
    expect(text).toMatch(/owner or a manager/u);
    expect(text).toMatch(/sign in as a staff member/u);
    expect(text).not.toMatch(/permission|session|scope|queue|Store/u);
    const chinese = zhHans[text];
    expect(chinese).toMatch(/店主或店长/u);
    expect(chinese).toMatch(/换有权限的员工登录/u);
    expect(chinese).not.toMatch(/队列|范围|会话/u);
  }
});
