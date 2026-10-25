import { expect, it } from "vitest";
import { waitingText } from "./RefundApprovalsPage.js";

it("Owner 2026-10-25: says how long a refund has waited, in the unit that reads naturally", () => {
  const at = Date.parse("2026-10-25T12:00:00.000Z");
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  expect(waitingText(ago(12), at)).toBe("Waiting 12 min");
  expect(waitingText(ago(5 * 60 + 10), at)).toBe("Waiting 5 h");
  // Ten days with no sign of it was the case found on v15.
  expect(waitingText(ago(10 * 24 * 60 + 30), at)).toBe("Waiting 10 days");
  // A clock slightly behind the server never reads as negative.
  expect(waitingText(new Date(at + 60_000).toISOString(), at)).toBe("Waiting 0 min");
});
