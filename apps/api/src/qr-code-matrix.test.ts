import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeQrMatrix, renderQrSvg } from "./qr-code-matrix.js";

const digest = (modules: readonly (readonly boolean[])[]) =>
  createHash("sha256")
    .update(modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")).join("\n"))
    .digest("hex");
const tableUrl = "https://127.0.0.1:4443/#qr=" + "eyJ".padEnd(560, "A");

/** Read the 15 format bits around the top-left finder (first copy) and the second copy. */
function formatCopies(modules: readonly (readonly boolean[])[]) {
  const size = modules.length;
  const at = (x: number, y: number) => (modules[y]?.[x] === true ? 1 : 0);
  const first: number[] = [];
  for (let i = 0; i <= 5; i++) first.push(at(8, i));
  first.push(at(8, 7), at(8, 8), at(7, 8));
  for (let i = 9; i < 15; i++) first.push(at(14 - i, 8));
  const second: number[] = [];
  for (let i = 0; i < 8; i++) second.push(at(size - 1 - i, 8));
  for (let i = 8; i < 15; i++) second.push(at(8, size - 15 + i));
  const value = (bits: number[]) => bits.reduce((sum, bit, i) => sum | (bit << i), 0);
  return [value(first), value(second)];
}

describe("WP-2423 Q11 QR matrix", () => {
  // Known answers: these exact matrices were decoded back to their text by macOS CoreImage
  // (CIDetectorTypeQRCode) on 2026-10-14, together with versions 2, 6, 13, 26 and 40.
  it("keeps the matrices that a phone decoder read back", () => {
    const hello = encodeQrMatrix("HELLO");
    expect(hello.version).toBe(1);
    expect(digest(hello.modules)).toBe(
      "71bc9ab3ffcaa0d281e4873d98c839634768a360dd4020111d405a3c41752367",
    );
    const table = encodeQrMatrix(tableUrl);
    expect(table.version).toBe(19);
    expect(digest(table.modules)).toBe(
      "253f9dfd1c6e450f3bb1b9a929c822701ab46fd9f32ac848673e6d7017fde816",
    );
  });

  it("draws finders, timing, the dark module and two matching level-M format copies", () => {
    for (const text of ["HELLO", "x".repeat(100), tableUrl]) {
      const { modules, size, version } = encodeQrMatrix(text);
      expect(size).toBe(version * 4 + 17);
      for (const [x, y] of [
        [0, 0],
        [size - 7, 0],
        [0, size - 7],
      ] as const) {
        expect(modules[y]?.[x]).toBe(true);
        expect(modules[y + 1]?.[x + 1]).toBe(false);
        expect(modules[y + 3]?.[x + 3]).toBe(true);
      }
      for (let i = 8; i < size - 8; i++) {
        expect(modules[6]?.[i]).toBe(i % 2 === 0);
        expect(modules[i]?.[6]).toBe(i % 2 === 0);
      }
      expect(modules[size - 8]?.[8]).toBe(true);
      const [first = -1, second] = formatCopies(modules);
      expect(first).toBe(second);
      // Level M is format bits 00 before masking with 0x5412.
      expect(((first ^ 0x5412) >>> 13) & 0b11).toBe(0);
    }
  });

  it("refuses text beyond version 40 and escapes the SVG label", () => {
    expect(() => encodeQrMatrix("x".repeat(2400))).toThrow("QR_TEXT_TOO_LONG");
    const svg = renderQrSvg(encodeQrMatrix("HELLO"), 'Table <"A">');
    expect(svg).toContain('aria-label="Table &lt;&quot;A&quot;&gt;"');
    expect(svg).toContain('viewBox="0 0 29 29"');
  });
});
