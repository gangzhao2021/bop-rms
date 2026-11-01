import { expect, it } from "vitest";
import { parseSupportArguments } from "./pilot-internal-test-support.mjs";

const common = ["--database", "db", "--migration-env", "env", "--reason", "Test"];
it("adds only a person named as TEST, and takes nothing it doesn't know", () => {
  expect(
    parseSupportArguments(["add", ".local/x", ...common, "--name", "TEST Support Sam"]).name,
  ).toBe("TEST Support Sam");
  for (const bad of [
    ["add", ".local/x", ...common, "--name", "Real Person"],
    ["add", ".local/x", ...common],
    ["add", ".local/x", ...common, "--name", "TEST A", "--store", "x"],
    ["promote", ".local/x", ...common],
    ["end", ".local/x", ...common],
  ])
    expect(() => parseSupportArguments(bad)).toThrow();
  expect(parseSupportArguments(["end", ".local/x", ...common, "--actor", "a"]).actor).toBe("a");
});
