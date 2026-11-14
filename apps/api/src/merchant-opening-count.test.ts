import { describe, expect, it } from "vitest";
import { parseOpeningCountCommandBody } from "./merchant-opening-count.js";

const id = (n: number) => "01909a13-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const body = (overrides: Record<string, unknown> = {}) => ({
  action: "Submit",
  operationReference: id(1),
  countReference: id(2),
  expectedVersion: 2,
  lines: null,
  ...overrides,
});
describe("WP-2423 opening count command body", () => {
  it("accepts create, save and post", () => {
    expect(
      parseOpeningCountCommandBody(body({ action: "Create", expectedVersion: null })).action,
    ).toBe("Create");
    expect(parseOpeningCountCommandBody(body({ action: "SaveLines", lines: [] })).action).toBe(
      "SaveLines",
    );
    expect(parseOpeningCountCommandBody(body({ action: "Post" })).action).toBe("Post");
  });
  it.each([
    ["a version on create", body({ action: "Create" })],
    ["lines on submit", body({ lines: [] })],
    ["save without lines", body({ action: "SaveLines" })],
    ["an unknown action", body({ action: "Import" })],
    ["an extra field", { ...body(), postedBy: id(9) }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseOpeningCountCommandBody(value)).toThrow(/Invalid/u);
  });
});
