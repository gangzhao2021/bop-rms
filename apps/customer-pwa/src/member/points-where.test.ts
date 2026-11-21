import { expect, it } from "vitest";
import { scanToOrderOnlyText } from "./MemberJoinPanel.js";

it("WP-2423 M58 (Owner #13): says points are earned on every scanned order but used only on a table's bill paid at the end", () => {
  const text = scanToOrderOnlyText();
  expect(text).toContain("You earn points on every order you scan to place.");
  expect(text).toContain("not on pickup or pay-first tables");
  // The old wording promised points could be used on any scanned order (pickup cannot redeem).
  expect(text).not.toContain("earned and used only on orders you place by scanning");
});
