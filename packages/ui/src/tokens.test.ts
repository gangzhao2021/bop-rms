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
    expect(contrast(color("success"), color("surface-default"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("warning"), color("surface-default"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("on-primary"), color("danger"))).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps the red and green marks (dots, outlines, bars) at 3:1 on white", () => {
    for (const mark of ["danger-mark", "success-mark"])
      for (const surface of ["surface-default", "surface-raised"])
        expect(
          contrast(color(mark), color(surface)),
          `${mark} on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
  });
  it("draws a control's line (field bottom line, button outline) at 3:1 on white (WCAG 1.4.11)", () => {
    expect(contrast(color("border-control"), color("surface-default"))).toBeGreaterThanOrEqual(3);
  });
  it("keeps keyboard, motion, and touch baselines mechanical", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain(".bop-skip-link");
    expect(css).not.toMatch(/https?:\/\//i);
  });
  it("paints the skip link only while it has keyboard focus (2026-10-21 live check)", () => {
    const rule = (selector: string) =>
      new RegExp(`(?:^|\\n)${selector.replace(/\./gu, "\\.")} \\{([^}]*)\\}`, "u").exec(css)?.[1] ??
      "";
    expect(rule(".bop-skip-link")).toContain("clip-path: inset(50%);");
    expect(rule(".bop-skip-link")).toContain("position: fixed;");
    expect(rule(".bop-skip-link:focus-visible")).toContain("clip-path: none;");
    expect(rule(".bop-skip-link:focus-visible")).toContain("transform: translateY(0);");
  });
  it("defines the shared spacing token consumed by both web surfaces", () => {
    expect(css).toMatch(/--bop-space-5:\s*1\.25rem;/u);
  });
});
