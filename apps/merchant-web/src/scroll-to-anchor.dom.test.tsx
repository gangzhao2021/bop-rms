// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollToAnchorWhenShown } from "./scroll-to-anchor.js";
import { SoleOperatorSection } from "./SoleOperatorSection.js";
import { mount, settle } from "./dom-test-kit.fixture.js";

// b19: Approvals links to Store setup's Permissions and safety at #sole-operator. The section loads
// after the page, so the link must wait for it, and the section must carry that id.
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
describe("b19 links to a section further down Store setup", () => {
  it("brings the section into view once it has rendered, once", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const stop = scrollToAnchorWhenShown("#sole-operator");
    expect(scrolled).not.toHaveBeenCalled();
    const later = document.createElement("section");
    later.id = "sole-operator";
    document.body.append(later);
    await Promise.resolve();
    expect(scrolled).toHaveBeenCalledTimes(1);
    document.body.append(document.createElement("p"));
    await Promise.resolve();
    expect(scrolled).toHaveBeenCalledTimes(1);
    stop();
  });
  it("ignores addresses that are not a section id", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    scrollToAnchorWhenShown("")();
    scrollToAnchorWhenShown("#a b")();
    expect(scrolled).not.toHaveBeenCalled();
  });
  it("the Sole operator section carries the id the links use", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));
    const { container } = await mount(
      <SoleOperatorSection
        csrf={"A".repeat(43)}
        fetcher={fetcher as unknown as typeof fetch}
        verifiedUntil={null}
        onVerified={() => undefined}
      />,
    );
    await settle();
    expect(container.querySelector("section#sole-operator")).not.toBeNull();
  });
});
