import { describe, expect, it } from "vitest";
import { applyOpeningCountChange, parseOpeningCountLines } from "../domain/opening-count.js";

const id = (n: number) => "01909a12-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const line = (overrides: Record<string, unknown> = {}) => ({
  lineReference: id(1),
  itemReference: id(2),
  locationReference: id(3),
  lotCode: null,
  expiryDate: null,
  quantity: "4.25",
  unitCostMinor: 1850,
  ...overrides,
});
const context = {
  tenantReference: id(10),
  brandReference: id(11),
  storeReference: id(12),
  actorReference: id(13),
  occurredAt: "2026-10-07T10:00:00.000Z",
};
describe("WP-2423 opening count", () => {
  it("parses well-formed lines", () => {
    expect(
      parseOpeningCountLines([
        line(),
        line({
          lineReference: id(4),
          lotCode: "L1",
          expiryDate: "2026-10-15",
          locationReference: id(5),
        }),
      ]),
    ).toHaveLength(2);
  });
  it.each([
    ["zero quantity", [line({ quantity: "0" })]],
    ["negative quantity", [line({ quantity: "-1" })]],
    ["float-looking quantity", [line({ quantity: "1e3" })]],
    ["expiry without lot", [line({ expiryDate: "2026-10-15" })]],
    ["impossible date", [line({ lotCode: "L1", expiryDate: "2026-02-30" })]],
    ["duplicate item and location", [line(), line({ lineReference: id(4) })]],
    ["fractional cost", [line({ unitCostMinor: 18.5 })]],
  ])("refuses %s", (_label, lines) => {
    expect(() => parseOpeningCountLines(lines)).toThrow();
  });
  it("moves Draft -> Submitted -> Posted and refuses changes after posting", () => {
    const draft = applyOpeningCountChange(
      null,
      { action: "Create", countReference: id(20) },
      context,
    );
    expect(() =>
      applyOpeningCountChange(draft, { action: "Submit", expectedVersion: 1 }, context),
    ).toThrow();
    const saved = applyOpeningCountChange(
      draft,
      { action: "SaveLines", expectedVersion: 1, lines: parseOpeningCountLines([line()]) },
      context,
    );
    const submitted = applyOpeningCountChange(
      saved,
      { action: "Submit", expectedVersion: 2 },
      context,
    );
    const posted = applyOpeningCountChange(
      submitted,
      { action: "Post", expectedVersion: 3 },
      context,
    );
    expect(posted).toMatchObject({ lifecycle: "Posted", version: 4, postedBy: id(13) });
    expect(() =>
      applyOpeningCountChange(posted, { action: "Reopen", expectedVersion: 4 }, context),
    ).toThrow(/ALREADY_POSTED/u);
    expect(() =>
      applyOpeningCountChange(submitted, { action: "Post", expectedVersion: 2 }, context),
    ).toThrow(/CONFLICT/u);
  });
});
