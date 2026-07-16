import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
function color(name: string) {
  const value = css.match(new RegExp(`--bop-color-${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  if (!value) throw new Error(`missing token ${name}`);
  return value;
}
function luminance(hex: string) {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((left, right) => right - left);
  const [lighter = 0, darker = 0] = values;
  return (lighter + 0.05) / (darker + 0.05);
}
describe("BOP Pilot Neutral tokens", () => {
  it("meets WCAG AA for key text pairs", () => {
    expect(contrast(color("text-default"), color("surface-canvas"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("on-primary"), color("brand-primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("danger"), color("surface-default"))).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps keyboard, motion, and touch baselines mechanical", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain(".bop-skip-link");
    expect(css).not.toMatch(/https?:\/\//i);
  });
});
