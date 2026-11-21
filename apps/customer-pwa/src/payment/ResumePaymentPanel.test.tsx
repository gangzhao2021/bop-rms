import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { ResumePaymentPanel, resumeStoppedText } from "./ResumePaymentPanel.js";

const session = "01909999-0000-7000-8000-000000000001";

it("WP-2423 abandoned payment: offers to finish the same payment with its amount and time", () => {
  const html = renderToStaticMarkup(
    <ResumePaymentPanel
      checkoutSessionReference={session}
      total={{ amountMinor: "1689", currency: "CAD" }}
      payBy="2099-01-01T12:30:00.000Z"
      configuration={{ mode: "simulation" }}
      online
      onSettled={() => undefined}
    />,
  );
  expect(html).toContain("Finish paying");
  expect(html).toContain("$16.89");
  expect(html).toContain("or it is cancelled and nobody is charged");
  expect(html).not.toContain(session);
  expect(
    renderToStaticMarkup(
      <ResumePaymentPanel
        checkoutSessionReference={session}
        total={null}
        payBy={null}
        configuration={null}
        online
        onSettled={() => undefined}
      />,
    ),
  ).toBe("");
  for (const text of Object.values(resumeStoppedText))
    expect(text).not.toMatch(/[A-Z]{3,}_|payment_|window_/u);
});

// v15 b17: the Chinese amount line uses Chinese punctuation: no space after the colon, a 句号.
it("v15 b17: the Chinese amount line reads 应付金额：$2.83。请在…", () => {
  const panel = (language: "en" | "zh-Hans") =>
    renderToStaticMarkup(
      <LanguageRoot initial={language}>
        {() => (
          <ResumePaymentPanel
            checkoutSessionReference={session}
            total={{ amountMinor: "283", currency: "CAD" }}
            payBy="2099-01-01T12:30:00.000Z"
            configuration={{ mode: "simulation" }}
            online
            onSettled={() => undefined}
          />
        )}
      </LanguageRoot>,
    ).replace(/<\/?strong>/gu, "");
  expect(panel("zh-Hans")).toMatch(/应付金额：\$2\.83。请在 /u);
  expect(panel("en")).toMatch(/Amount to pay: \$2\.83\. Pay by /u);
});
