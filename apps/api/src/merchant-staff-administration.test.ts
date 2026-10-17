import { describe, expect, it } from "vitest";
import { parseOwnNameCommand, parseStaffCommand } from "./merchant-staff-administration.js";

const id = (n: number) => "01909a0c-0000-7000-8000-" + n.toString(16).padStart(12, "0");

describe("WP-2423 staff administration command input", () => {
  it.each([
    {
      operation: "SetDisplayName",
      actorReference: id(1),
      expectedProfileVersion: 0,
      displayName: "Mia Chen",
      operationReference: id(2),
    },
    {
      operation: "RequestRole",
      actorReference: id(1),
      roleReference: id(3),
      operationReference: id(2),
    },
    { operation: "Approve", changeReference: id(4) },
    { operation: "Withdraw", changeReference: id(4) },
    { operation: "Revoke", assignmentReference: id(5), operationReference: id(2) },
    { operation: "RemoveFromStore", actorReference: id(1), operationReference: id(2) },
  ])("accepts $operation", (value) => {
    expect(parseStaffCommand(value).operation).toBe(value.operation);
  });
  it.each([
    ["unknown operation", { operation: "Delete", changeReference: id(4) }],
    ["removal without operation", { operation: "RemoveFromStore", actorReference: id(1) }],
    ["extra field", { operation: "Approve", changeReference: id(4), decidedBy: id(9) }],
    ["bad reference", { operation: "Approve", changeReference: "not-a-uuid" }],
    [
      "negative version",
      {
        operation: "SetDisplayName",
        actorReference: id(1),
        expectedProfileVersion: -1,
        displayName: "x",
        operationReference: id(2),
      },
    ],
    [
      "missing role",
      { operation: "RequestRole", actorReference: id(1), operationReference: id(2) },
    ],
  ])("refuses %s", (_label, value) => {
    expect(() => parseStaffCommand(value)).toThrow(/Invalid/u);
  });
});

describe("WP-2423 a member records their own first name", () => {
  it("accepts a name with version 0 and an operation reference", () => {
    expect(
      parseOwnNameCommand({
        displayName: "Mia Chen",
        expectedProfileVersion: 0,
        operationReference: id(2),
      }),
    ).toEqual({ displayName: "Mia Chen", expectedProfileVersion: 0, operationReference: id(2) });
  });
  it.each([
    [
      "a rename (version after the first name)",
      { displayName: "Mia", expectedProfileVersion: 1, operationReference: id(2) },
    ],
    [
      "someone else",
      {
        displayName: "Mia",
        expectedProfileVersion: 0,
        operationReference: id(2),
        actorReference: id(1),
      },
    ],
    ["no operation", { displayName: "Mia", expectedProfileVersion: 0 }],
    ["bad operation", { displayName: "Mia", expectedProfileVersion: 0, operationReference: "x" }],
    ["no name", { displayName: null, expectedProfileVersion: 0, operationReference: id(2) }],
    ["not an object", ["Mia"]],
  ])("refuses %s", (_label, value) => {
    expect(() => parseOwnNameCommand(value)).toThrow(/Invalid/u);
  });
});
