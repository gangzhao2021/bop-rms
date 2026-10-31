import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  parseSoleOperatorGate,
  SoleOperatorSelfApproval,
  soleOperatorOtherNames,
} from "./SoleOperatorSelfApproval.js";

const render = (gate: unknown) =>
  renderToStaticMarkup(
    <SoleOperatorSelfApproval
      gate={parseSoleOperatorGate(gate)}
      csrf={"c".repeat(43)}
      summary={<p>CAD_BASE: 3 prices</p>}
      what="these prices"
      permissionName="price approval"
      actionLabel="Publish on my own"
      busy={false}
      onApprove={() => undefined}
    />,
  );

describe("WP-2423 Q19 self-approval at Brand gates", () => {
  it("explains why another person must approve when not in effect, naming them", () => {
    expect(render(null)).toContain("someone else who holds price approval must approve it");
    expect(render({ status: "NotSet", otherApprovers: [], verifiedUntil: null })).toContain(
      "the brand owner can turn on Sole operator",
    );
    const other = render({
      status: "OtherApprovers",
      otherApprovers: [{ displayName: "Mia" }, { displayName: null }],
      verifiedUntil: null,
    });
    expect(other).toContain("Mia and another staff member also hold price approval");
    expect(other).not.toContain("Publish on my own");
  });
  it("offers the summary, a verification and an explicit confirmation when in effect", () => {
    const html = render({ status: "Effective", otherApprovers: [], verifiedUntil: null });
    expect(html).toContain("CAD_BASE: 3 prices");
    expect(html).toContain("recorded as approved by you alone");
    expect(html).toContain("I checked these prices and approve on my own");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish on my own<\/button>/u);
  });
  it("reads the gate strictly", () => {
    expect(() =>
      parseSoleOperatorGate({ status: "Maybe", otherApprovers: [], verifiedUntil: null }),
    ).toThrow();
    expect(() => parseSoleOperatorGate({ status: "NotSet", otherApprovers: [] })).toThrow();
    expect(
      soleOperatorOtherNames({
        status: "OtherApprovers",
        otherApprovers: [{ displayName: "A" }, { displayName: "B" }, { displayName: "C" }],
        verifiedUntil: null,
      }),
    ).toBe("A, B and C");
  });
});
