import { describe, expect, it } from "vitest";
import { parseConsumerRetryArguments } from "./consumer-retry-operations.mjs";

const operator = "01909a25-0000-7000-8000-000000000001";
const target = ["--env-file", "x.env", "--confirm-target", "local:db", "--operator", operator];
describe("WP-2423 consumer retry operations", () => {
  it("accepts each command with exactly its flags", () => {
    expect(parseConsumerRetryArguments(["list", "--env-file", "x.env"]).command).toBe("list");
    const one = parseConsumerRetryArguments([
      "retry-now",
      ...target,
      "--consumer",
      "inventory.order-line-kitchenworkstarted:v1",
    ]);
    expect(one.get("--consumer")).toBe("inventory.order-line-kitchenworkstarted:v1");
    expect(one.has("--all")).toBe(false);
    expect(one.has("--dry-run")).toBe(false);
    const all = parseConsumerRetryArguments(["retry-now", "--dry-run", ...target, "--all"]);
    expect(all.get("--consumer")).toBeNull();
    expect(all.has("--all")).toBe(true);
    expect(all.has("--dry-run")).toBe(true);
    expect(all.get("--operator")).toBe(operator);
  });
  it.each([
    [["retry", ...target, "--all"]],
    [["list"]],
    [["list", "--env-file", "x", "--all"]],
    [["list", "--env-file", "x", "--operator", operator]],
    // exactly one of --consumer and --all
    [["retry-now", ...target]],
    [["retry-now", ...target, "--all", "--consumer", "a:v1"]],
    [["retry-now", ...target, "--all", "--all"]],
    [["retry-now", ...target, "--all", "--dry-run", "--dry-run"]],
    [["retry-now", ...target, "--consumer", "Bad Name"]],
    [["retry-now", ...target, "--consumer"]],
    [["retry-now", ...target, "--dry-run", "yes", "--all"]],
    [["retry-now", "--env-file", "x", "--operator", operator, "--all"]],
    [["retry-now", "--env-file", "x", "--confirm-target", "t", "--operator", "nope", "--all"]],
  ])("refuses %j", (args) => {
    expect(() => parseConsumerRetryArguments(args)).toThrow();
  });
});
