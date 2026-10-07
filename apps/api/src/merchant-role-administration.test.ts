import { describe, expect, it } from "vitest";
import { parseRoleCommandInput } from "./merchant-role-administration.js";

const id = (n: number) => "01909a0a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = (overrides: Record<string, unknown> = {}) => ({
  operation: "Submit",
  roleReference: id(1),
  expectedVersion: 2,
  operationReference: id(2),
  reasonCode: "ROLE_SUBMITTED",
  draft: null,
  ...overrides,
});
const draft = {
  displayName: "Shift lead",
  description: "Orders and kitchen",
  actions: ["merchant.access", "ordering.order.read"],
};

describe("WP-2423 role administration command input", () => {
  it("accepts closed commands and drafts of catalog codes only", () => {
    expect(parseRoleCommandInput(command()).operation).toBe("Submit");
    expect(
      parseRoleCommandInput(command({ operation: "SaveDraft", draft })).draft?.actions,
    ).toEqual(draft.actions);
    expect(
      parseRoleCommandInput(
        command({ operation: "Duplicate", draft: { ...draft, code: "shift_lead" } }),
      ).draft?.code,
    ).toBe("shift_lead");
  });
  it.each([
    ["unknown operation", command({ operation: "Delete" })],
    ["draft on a decision", command({ draft })],
    ["missing draft", command({ operation: "SaveDraft" })],
    [
      "legacy code selected directly",
      command({ operation: "SaveDraft", draft: { ...draft, actions: ["kitchen.operate"] } }),
    ],
    [
      "unknown code",
      command({ operation: "SaveDraft", draft: { ...draft, actions: ["anything.at.all"] } }),
    ],
    [
      "duplicate code",
      command({
        operation: "SaveDraft",
        draft: { ...draft, actions: ["merchant.access", "merchant.access"] },
      }),
    ],
    ["code on save", command({ operation: "SaveDraft", draft: { ...draft, code: "x_y" } })],
    ["bad role code", command({ operation: "Duplicate", draft: { ...draft, code: "Shift-Lead" } })],
    ["extra field", { ...command(), actor: id(9) }],
    ["bad version", command({ expectedVersion: 0 })],
    ["bad reason", command({ reasonCode: "submitted" })],
  ])("refuses %s", (_label, value) => {
    expect(() => parseRoleCommandInput(value)).toThrow(/Invalid/u);
  });
});
