import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OptionSetPublicationPanel } from "./OptionSetPublicationPanel.js";
const id = (n: number) => "01902421-7b00-7000-8000-" + n.toString(16).padStart(12, "0");
it("first render locks publication pending inspection, with accessible recovery/confirmation and no authority inference", () => {
  const html = renderToStaticMarkup(
    <OptionSetPublicationPanel
      optionSetReference={id(6)}
      savedAggregateVersion={1}
      scope={{ brandReference: id(2), storeReference: id(3) }}
      csrf={"A".repeat(43)}
      blocked={false}
      onPendingChange={vi.fn()}
      onCurrentRefresh={async () => undefined}
    />,
  );
  expect(html).toContain('aria-label="Option Set publication"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Loading publication context");
  expect(html).toContain("Submit saved Draft for review");
  expect(html).toContain("Approve as independent actor");
  expect(html).toContain("Publish saved Draft");
  expect(html).toContain('disabled=""');
  expect(html).toContain("successor");
  expect(html).toContain("sale eligibility");
  expect(html).not.toContain(id(6));
  expect(html).not.toContain("ready for sale");
});
it("protects unsaved authoring and identifies current detail history separately", () => {
  const html = renderToStaticMarkup(
    <OptionSetPublicationPanel
      optionSetReference={id(6)}
      savedAggregateVersion={1}
      scope={{ brandReference: id(2), storeReference: id(3) }}
      csrf={"A".repeat(43)}
      blocked
      onPendingChange={vi.fn()}
      onCurrentRefresh={async () => undefined}
    />,
  );
  expect(html).toContain("Save or discard unsaved changes");
  expect(html).toContain(
    "Open current detail for recorded history, version comparison and current Published content",
  );
  expect(html).not.toContain("Published frozen version confirmed");
});
