import { describe, expect, it } from "vitest";
import { parseHandoffCells, phaseFor, workPackages } from "./handoff-row.mjs";

describe("Handoff Screen table contracts", () => {
  it("keeps four-column actions and Phase separate", () => {
    const [, , search, action, , phase] = parseHandoffCells([
      "CUST-PROFILE /account/profile",
      "minimum profile; verified contacts",
      "update / verify; request export; sign out / revoke Session",
      "Phase 3 / WP-2140、2144、2146",
    ]);
    expect(action).toContain("sign out / revoke Session");
    expect(search).toBe("—");
    expect(phaseFor(phase)).toEqual(["phase_3", "phase_capability"]);
    expect(workPackages(phase)).toEqual(["WP-2140", "WP-2144", "WP-2146"]);
  });
  it("preserves explicit six-column operational contracts", () => {
    const cells = [
      "OPS-ORDER-QUEUE",
      "Order summary",
      "Store / status",
      "accept",
      "named Actor",
      "Phase 1 / WP-1221–1226、1803",
    ];
    expect(parseHandoffCells(cells)).toEqual(cells);
    expect(workPackages(cells[5])).toEqual([
      "WP-1221",
      "WP-1222",
      "WP-1223",
      "WP-1224",
      "WP-1225",
      "WP-1226",
      "WP-1803",
    ]);
  });
  it("retains three-column shared placement inheritance", () => {
    const [, fields, search, actions, access, phase] = parseHandoffCells([
      "SHARED-PICKER",
      "safe summary",
      "inherited from first consuming WP",
    ]);
    expect(fields).toBe("safe summary");
    expect(search).toBe("inherits parent Screen");
    expect(actions).toBe("inherits parent Screen");
    expect(access).toBe(phase);
    expect(phaseFor(phase)).toEqual(["inherited", "inherited_feature_gate"]);
    expect(workPackages(phase)).toEqual([]);
  });
  it("does not turn Provider-specific Phase or Future gates into inheritance", () => {
    expect(phaseFor("Phase-specific / WP-2003、2182")).toEqual([
      "phase_specific",
      "phase_capability",
    ]);
    expect(phaseFor("Future Trigger / WP-1502")).toEqual([
      "future_trigger",
      "future_trigger_disabled",
    ]);
  });
  it("expands omitted prefixes and deduplicates explicit and abbreviated ranges", () => {
    expect(workPackages("Phase 1 / WP-1709、1720–1724、2028; WP-1724, WP-2028")).toEqual([
      "WP-1709",
      "WP-1720",
      "WP-1721",
      "WP-1722",
      "WP-1723",
      "WP-1724",
      "WP-2028",
    ]);
  });
  it("does not consume unrelated dates, Section numbers or numeric prose", () => {
    expect(workPackages("Sections 2140, 2144; 2026-09-10; WP-2140 + Customer IDR 2146")).toEqual([
      "WP-2140",
    ]);
  });
  it.each(["WP-1709–1700", "WP-1000–1100"])("rejects malformed bounded range %s", (value) => {
    expect(() => workPackages(value)).toThrow("invalid Work Package range");
  });
  it("rejects unsupported table shapes instead of inventing inheritance", () => {
    expect(() => parseHandoffCells(["screen", "fields"])).toThrow(
      "unsupported Screen Registry table shape",
    );
  });
});
