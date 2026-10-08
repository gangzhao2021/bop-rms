import { describe, expect, it } from "vitest";
import { parseDeadLetterArguments } from "./dead-letter-operations.mjs";

const operator = "01909a25-0000-7000-8000-000000000001";
describe("WP-2423 dead-letter operations", () => {
  it("accepts each command with exactly its flags", () => {
    expect(parseDeadLetterArguments(["list", "--env-file", "x.env"]).command).toBe("list");
    const retry = parseDeadLetterArguments([
      "retry",
      "--env-file",
      "x.env",
      "--confirm-target",
      "local:db",
      "--operator",
      operator,
      "--consumer",
      "inventory.order-line-kitchenworkstarted:v1",
      "--since",
      "2026-10-08",
    ]);
    expect(retry.get("--since")).toBe("2026-10-08");
  });
  it.each([
    [["delete", "--env-file", "x"]],
    [["list"]],
    [["list", "--env-file", "x", "--operator", operator]],
    [
      [
        "discard",
        "--env-file",
        "x",
        "--confirm-target",
        "t",
        "--operator",
        "nope",
        "--dead-letter",
        operator,
      ],
    ],
    [
      [
        "retry",
        "--env-file",
        "x",
        "--confirm-target",
        "t",
        "--operator",
        operator,
        "--consumer",
        "Bad Name",
      ],
    ],
    [
      [
        "retry",
        "--env-file",
        "x",
        "--confirm-target",
        "t",
        "--operator",
        operator,
        "--consumer",
        "a:v1",
        "--since",
        "10/08",
      ],
    ],
  ])("refuses %j", (args) => {
    expect(() => parseDeadLetterArguments(args)).toThrow();
  });
});
