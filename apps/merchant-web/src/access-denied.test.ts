import { expect, it } from "vitest";
import {
  actionAccessDeniedText,
  brandChangeDeniedText,
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

it("batch 38 review: an action refusal names the role, never the session, and is translated", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const refusals: Record<string, RegExp> = {
    "StepUpVerification.tsx": /Denied: t\(\s*"([^"]+)"/u,
    "UnpaidRoundCancelAction.tsx": /Denied: t\(\s*"([^"]+)"/u,
    "StaffOrderCancelAction.tsx": /Denied: t\(\s*"([^"]+)"/u,
    "StaffItemCancelAction.tsx": /case "Denied":\s*return t\(\s*"([^"]+)"/u,
    "counter-payment.ts": /case "PermissionDenied":\s*return t\(\s*"([^"]+)"/u,
  };
  for (const [file, pattern] of Object.entries(refusals)) {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    const text = pattern.exec(source)?.[1];
    expect(text, file).toMatch(/^(Your role can't|You're signed out, or your role can't)/u);
    expect(text, file).not.toMatch(/session|permission/iu);
    expect(zhHans[text ?? ""], file).toMatch(/店主/u);
  }
  // The brand panel's refusal comes from here, translated, like every other refusal.
  expect(brandChangeDeniedText).toMatch(/^Your role can't change this brand/u);
  expect(zhHans[brandChangeDeniedText]).toMatch(/店主/u);
  const brand = readFileSync(join(import.meta.dirname, "BrandConfigurationPanel.tsx"), "utf8");
  expect(brand).toMatch(/Denied: brandChangeDeniedText/u);
  // The old generic refusal has no screen left that says it.
  expect(zhHans["Permission denied. Check your session and Store access."]).toBeUndefined();
});
