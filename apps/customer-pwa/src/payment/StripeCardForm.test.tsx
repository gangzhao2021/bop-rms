import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { StripeCardForm } from "./StripeCardForm.js";
it("keeps payment credentials out of HTML and disables submission until SDK readiness", () => {
  const secret = "pi_SYNTHETIC000001_secret_SYNTHETICONLY";
  const html = renderToStaticMarkup(
    <StripeCardForm
      publishableKey="pk_test_SYNTHETICONLY"
      returnUrl="https://payment-return.example/"
      clientSecret={secret}
      onSubmitted={() => {
        throw new Error("must not submit");
      }}
    />,
  );
  expect(html).not.toContain(secret);
  expect(html).not.toContain("pk_test_SYNTHETICONLY");
  expect(html).toContain('disabled=""');
  expect(html).toContain("Loading secure card form");
  expect(html).not.toContain('type="text"');
});
