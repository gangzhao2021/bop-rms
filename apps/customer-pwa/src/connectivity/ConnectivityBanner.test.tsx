import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { ConnectivityBanner } from "./ConnectivityBanner.js";
import type { ConnectivityController, ConnectivityState } from "./connectivity-controller.js";

function controller(state: ConnectivityState): ConnectivityController {
  return {
    getState: () => state,
    setOnline: () => undefined,
    dismissRestored: () => undefined,
    dispose: () => undefined,
    subscribe: () => () => undefined,
  };
}

describe("Customer PWA connectivity banner", () => {
  it("renders no banner while online", () => {
    expect(
      renderToStaticMarkup(<ConnectivityBanner controller={controller({ status: "online" })} />),
    ).toBe("");
  });

  it("makes offline read-only and no-replay behavior explicit", () => {
    const html = renderToStaticMarkup(
      <ConnectivityBanner controller={controller({ status: "offline" })} />,
    );
    expect(html).toContain("You’re offline");
    expect(html).toContain("Ordering and payment are paused until you reconnect");
    expect(html).toContain("Nothing is sent in the background");
    expect(html).toContain('aria-live="polite"');
  });

  it("says the page updates by itself and never claims nothing was sent after restoration (M17, M94)", () => {
    const html = renderToStaticMarkup(
      <ConnectivityBanner controller={controller({ status: "restored" })} />,
    );
    expect(html).toContain("Connection restored");
    // WP-2423 M17: a confirm sent just before the drop may have gone through; never claim otherwise.
    // M94: the page reads again by itself, so the guest is not asked to re-check or retry.
    expect(html).toContain("Updating this page");
    expect(html).toContain("anything that went through");
    expect(html).not.toContain("try again");
    expect(html).not.toContain("Nothing was sent");
    expect(html).toContain("Dismiss");
  });

  // Batch 57 (sweep after v15 b56 live): Chinese sentences follow each other with no space
  // ("您已离线。 恢复网络前…" read as a gap); English keeps one.
  it.each([
    ["offline", "en", "You’re offline. Ordering"],
    ["offline", "zh-Hans", "您已离线。恢复网络前"],
    ["restored", "en", "Connection restored. Updating"],
    ["restored", "zh-Hans", "网络已恢复。"],
  ] as const)(
    "joins the %s sentences in %s without a space after a Chinese full stop",
    (status, language, said) => {
      const text = renderToStaticMarkup(
        <LanguageRoot initial={language}>
          {() => <ConnectivityBanner controller={controller({ status })} />}
        </LanguageRoot>,
      ).replace(/<[^>]+>/gu, "");
      expect(text).toContain(said);
      expect(text).not.toMatch(/[。！？；] /u);
      renderToStaticMarkup(<LanguageRoot initial="en">{() => null}</LanguageRoot>);
    },
  );
});
