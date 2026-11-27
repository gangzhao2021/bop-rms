import { expect, it } from "vitest";
import { parseCanonicalInstant } from "../domain/brand-store.js";

it("batch 37: an instant checked before is answered the same; an invalid one is still refused", () => {
  for (let n = 0; n < 2; n++) {
    expect(parseCanonicalInstant("2026-11-20T10:13:01.000Z")).toBe("2026-11-20T10:13:01.000Z");
    for (const invalid of [
      "2026-02-30T00:00:00.000Z",
      "2026-11-20T10:13:01Z",
      " 2026-11-20T10:13:01.000Z",
      1793664000000,
      null,
    ])
      expect(() => parseCanonicalInstant(invalid)).toThrow();
  }
});
