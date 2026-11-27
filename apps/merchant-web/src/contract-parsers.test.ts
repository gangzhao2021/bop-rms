import { describe, expect, it } from "vitest";
import { createContractParsers } from "./contract-parsers.js";

const fail = (): never => {
  throw new Error("REFUSED");
};
const p = createContractParsers(fail);
const id = "018f7700-0000-7000-8000-000000000001";

describe("WP-2423 C3 shared contract parsers", () => {
  it("accepts canonical values", () => {
    expect(p.instant("2026-10-10T08:00:00.000Z")).toBe("2026-10-10T08:00:00.000Z");
    expect(p.reference(id)).toBe(id);
    expect(p.text("Latte", 5)).toBe("Latte");
    expect(p.minor("0")).toBe("0");
    expect(p.minor("1130")).toBe("1130");
    expect(p.count(0)).toBe(0);
    expect(p.integer(3, 1)).toBe(3);
    expect(p.bool(false)).toBe(false);
    expect(p.oneOf("Open", ["Open", "Closed"])).toBe("Open");
    expect(p.exact({ a: 1, b: 2 }, ["b", "a"])).toEqual({ a: 1, b: 2 });
    expect(p.optional(null, p.minor)).toBeNull();
    expect(p.optional("5", p.minor)).toBe("5");
  });
  it("refuses everything else through the caller's fail", () => {
    for (const call of [
      () => p.instant("2026-10-10T08:00:00Z"),
      () => p.instant("2026-13-45T08:00:00.000Z"),
      () => p.instant(1),
      () => p.reference(id.replace("-7000-", "-4000-")),
      () => p.text("", 5),
      () => p.text("Latte!", 5),
      () => p.minor("-1"),
      () => p.minor("01"),
      () => p.minor(1130),
      () => p.count(-1),
      () => p.count(1.5),
      () => p.integer(0, 1),
      () => p.bool("true"),
      () => p.oneOf("Paused", ["Open", "Closed"]),
      () => p.exact({ a: 1 }, ["a", "b"]),
      () => p.exact({ a: 1, c: 3 }, ["a", "b"]),
      () => p.exact([1], ["0"]),
      () => p.exact(null, []),
      () => p.optional(undefined, p.minor),
    ])
      expect(call).toThrow("REFUSED");
  });
});
