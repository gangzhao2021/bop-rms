import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  acceptanceHoldRefundOutcome,
  AcceptanceHoldRefundStatus,
} from "./AcceptanceHoldActions.js";

const csrf = "c".repeat(43);

it("WP-2423: a held-order refund refused on a PIN sign-in asks to confirm it is them", () => {
  expect(acceptanceHoldRefundOutcome(403, { error: "full_sign_in_required" })).toBe(
    "FullSignInRequired",
  );
  expect(acceptanceHoldRefundOutcome(403, { error: "forbidden" })).toBe("Denied");
  expect(acceptanceHoldRefundOutcome(403, null)).toBe("Denied");
  expect(acceptanceHoldRefundOutcome(202, null)).toBe("Done");
  expect(acceptanceHoldRefundOutcome(409, null)).toBe("NotHeld");
  expect(acceptanceHoldRefundOutcome(502, null)).toBe("Unknown");
  const html = renderToStaticMarkup(
    <AcceptanceHoldRefundStatus outcome="FullSignInRequired" csrf={csrf} />,
  );
  expect(html).toContain("You signed in with a PIN");
  expect(html).toContain("Verify it&#x27;s you");
  expect(html).not.toContain("Only a store manager or owner");
});
