import { expect, it } from "vitest";
import { parseCanonicalInstant, readClosedRecord } from "../contracts/identity-actor.js";

it("batch 37: an instant checked before is answered the same; an invalid one is still refused", () => {
  for (const parse of [parseCanonicalInstant])
    for (let n = 0; n < 2; n++) {
      expect(parse("2026-11-20T10:13:01.000Z")).toBe("2026-11-20T10:13:01.000Z");
      for (const invalid of [
        "2026-02-30T00:00:00.000Z",
        "2026-11-20T10:13:01Z",
        "2026-11-20T10:13:01.000+00:00",
        " 2026-11-20T10:13:01.000Z",
        1793664000000,
        null,
      ])
        expect(() => parse(invalid)).toThrow();
    }
});

it("batch 37: a closed record is still exactly its own data properties", () => {
  const keys = ["a", "b"];
  expect(readClosedRecord({ a: 1, b: 2 }, keys)).toEqual({ a: 1, b: 2 });
  expect(Object.isFrozen(readClosedRecord({ b: 2, a: 1 }, keys))).toBe(true);
  const refused = [
    { a: 1 },
    { a: 1, b: 2, c: 3 },
    { a: 1, c: 3 },
    Object.assign(Object.create(null), { a: 1, b: 2 }),
    [1, 2],
    null,
    Object.defineProperty({ a: 1 }, "b", { get: () => 2, enumerable: true }),
    Object.defineProperty({ a: 1 }, "b", { value: 2, enumerable: false }),
    Object.assign({ a: 1, b: 2 }, { [Symbol("x")]: 3 }),
  ];
  for (const value of refused) expect(() => readClosedRecord(value, keys)).toThrow();
});
