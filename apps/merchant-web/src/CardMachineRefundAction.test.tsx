import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { cardMachineRefundOutcome, CardMachineRefundStatus } from "./CardMachineRefundAction.js";

const csrf = "c".repeat(43);

it("WP-2423: a PIN sign-in refusal asks to confirm it is them; a plain 403 stays denied", () => {
  expect(cardMachineRefundOutcome(403, "full_sign_in_required")).toBe("FullSignInRequired");
  expect(cardMachineRefundOutcome(403, "forbidden")).toBe("Denied");
  expect(cardMachineRefundOutcome(403, null)).toBe("Denied");
});

it("WP-2423: shows the verification step instead of the manager-only message", () => {
  const html = renderToStaticMarkup(
    <CardMachineRefundStatus outcome="FullSignInRequired" csrf={csrf} />,
  );
  expect(html).toContain("You signed in with a PIN");
  expect(html).toContain("Verify it&#x27;s you");
  expect(html).not.toContain("Only a store manager or owner");
  const denied = renderToStaticMarkup(<CardMachineRefundStatus outcome="Denied" csrf={csrf} />);
  expect(denied).toContain("Only a store manager or owner");
  expect(denied).not.toContain("You signed in with a PIN");
});
