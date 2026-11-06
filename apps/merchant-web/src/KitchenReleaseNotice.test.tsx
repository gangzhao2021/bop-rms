import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setLanguageForTest } from "./i18n/i18n.js";
import { AutomaticRefundLateNotice, KitchenReleaseNotice } from "./KitchenReleaseNotice.js";

afterEach(() => setLanguageForTest("en"));
const acceptedAt = "2026-11-06T04:35:19.000Z";
const at = (seconds: number) => Date.parse(acceptedAt) + seconds * 1000;

// WP-2423 M04: Tables said "Sent to the kitchen" for 8 to 19 minutes while the kitchen had nothing.
it("says a paid round is being sent, then that it has not reached the kitchen, in staff words", () => {
  const sending = renderToStaticMarkup(
    <KitchenReleaseNotice release={{ state: "Sending", acceptedAt }} now={at(5)} />,
  );
  expect(sending).toContain('role="status"');
  expect(sending).toContain("Sending to the kitchen…");
  expect(sending).not.toContain("Sent to the kitchen");
  const late = renderToStaticMarkup(
    <KitchenReleaseNotice release={{ state: "Sending", acceptedAt }} now={at(150)} />,
  );
  expect(late).toContain("Not in the kitchen yet");
  expect(late).toContain("accepted 2 min ago");
  expect(late).toContain("Make it from the dishes listed here and tell the manager.");
  expect(late).toContain('data-tier="warning"');
  // Released: nothing to say.
  expect(renderToStaticMarkup(<KitchenReleaseNotice release={null} now={at(5)} />)).toBe("");
  setLanguageForTest("zh-Hans");
  expect(
    renderToStaticMarkup(
      <KitchenReleaseNotice release={{ state: "NotInKitchen", acceptedAt }} now={at(61)} />,
    ),
  ).toContain("还没进后厨");
  expect(
    renderToStaticMarkup(
      <KitchenReleaseNotice release={{ state: "Sending", acceptedAt }} now={at(1)} />,
    ),
  ).toContain("正在发送到后厨…");
  expect(renderToStaticMarkup(<AutomaticRefundLateNotice late />)).toContain("自动退款没有完成");
});
it("tells staff to reject a pickup whose automatic refund did not go through", () => {
  const html = renderToStaticMarkup(<AutomaticRefundLateNotice late />);
  expect(html).toContain("The automatic refund didn&#x27;t go through.");
  expect(html).toContain("Reject the order to refund the guest in full.");
  expect(renderToStaticMarkup(<AutomaticRefundLateNotice late={false} />)).toBe("");
});
