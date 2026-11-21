import { describe, expect, it } from "vitest";
import { parseOutboxRecoveryArguments } from "./outbox-recovery-operations.mjs";

const operator = "01909a25-0000-7000-8000-000000000001";
const item = "01909a25-0000-7000-8000-000000000002";
describe("WP-2423 Outbox recovery operations", () => {
  it("recovers every eligible item or one named item for a named operator", () => {
    expect(parseOutboxRecoveryArguments(["recover", "--operator", operator])).toEqual({
      operator,
      deadLetter: null,
    });
    expect(
      parseOutboxRecoveryArguments(["recover", "--operator", operator, "--dead-letter", item]),
    ).toEqual({ operator, deadLetter: item });
  });
  it.each([
    [["recover"]],
    [["retry", "--operator", operator]],
    [["recover", "--operator", "not-a-uuid"]],
    [["recover", "--operator", operator, "--operator", operator]],
    [["recover", "--operator", operator, "--consumer", "a:v1"]],
  ])("refuses %j", (args) => {
    expect(() => parseOutboxRecoveryArguments(args)).toThrow();
  });
});
