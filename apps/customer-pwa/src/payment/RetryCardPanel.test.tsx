import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { RetryCardPanel, retryStoppedText } from "./RetryCardPanel.js";

const session = "01909999-0000-7000-8000-000000000001";

it("WP-2423 Q20: offers another card for the same amount, and nothing without a payment form", () => {
  const html = renderToStaticMarkup(
    <RetryCardPanel
      checkoutSessionReference={session}
      total={{ amountMinor: "2260", currency: "CAD" }}
      configuration={{ mode: "simulation" }}
      online
      onSettled={() => undefined}
    />,
  );
  expect(html).toContain("Pay with another card");
  expect(html).toContain("$22.60");
  expect(html).toContain("Try another card");
  expect(html).not.toContain(session);
  expect(
    renderToStaticMarkup(
      <RetryCardPanel
        checkoutSessionReference={session}
        total={null}
        configuration={null}
        online
        onSettled={() => undefined}
      />,
    ),
  ).toBe("");
  const offline = renderToStaticMarkup(
    <RetryCardPanel
      checkoutSessionReference={session}
      total={null}
      configuration={{ mode: "simulation" }}
      online={false}
      onSettled={() => undefined}
    />,
  );
  expect(offline).toContain("disabled");
  expect(offline).toContain("Reconnect to pay with another card.");
});

it("WP-2423 Q20: explains plainly why another card cannot be tried", () => {
  for (const text of Object.values(retryStoppedText)) {
    expect(text).not.toMatch(/[A-Z]{3,}_|payment_|retry_|window_/u);
  }
  expect(retryStoppedText.retry_limit).toContain("Ask staff to pay at the counter.");
  expect(retryStoppedText.window_ended).toContain("you haven’t been charged");
});

it("v15 b17: the Chinese amount line has no space after the colon", () => {
  const panel = (language: "en" | "zh-Hans") =>
    renderToStaticMarkup(
      <LanguageRoot initial={language}>
        {() => (
          <RetryCardPanel
            checkoutSessionReference={session}
            total={{ amountMinor: "283", currency: "CAD" }}
            configuration={{ mode: "simulation" }}
            online
            onSettled={() => undefined}
          />
        )}
      </LanguageRoot>,
    ).replace(/<\/?strong>/gu, "");
  expect(panel("zh-Hans")).toContain("应付金额：$2.83</p>");
  expect(panel("en")).toContain("Amount to pay: $2.83</p>");
});
