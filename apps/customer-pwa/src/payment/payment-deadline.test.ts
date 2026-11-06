import { expect, it } from "vitest";
import {
  earlierPaymentDeadline,
  nextPaymentDeadlineChangeMs,
  paymentDeadlineFrom,
  paymentDeadlinePhase,
} from "./payment-deadline.js";

const at = (iso: string) => Date.parse(iso);

it("WP-2423 M19: runs from the server's time when the phone's clock is off", () => {
  // The phone is eight minutes fast: by its clock the deadline has nearly passed.
  const deadline = paymentDeadlineFrom(
    "2026-08-03T15:30:00.000Z",
    "2026-08-03T15:20:00.000Z",
    at("2026-08-03T15:28:00.000Z"),
  );
  expect(deadline).not.toBeNull();
  if (deadline === null) return;
  // Ten minutes are left on the server's clock: no warning yet, the card stays offered.
  expect(paymentDeadlinePhase(deadline, at("2026-08-03T15:28:00.000Z"))).toBe("open");
  expect(nextPaymentDeadlineChangeMs(deadline, at("2026-08-03T15:28:00.000Z"))).toBe(300_000);
  expect(paymentDeadlinePhase(deadline, at("2026-08-03T15:33:00.000Z"))).toBe("warning");
  expect(nextPaymentDeadlineChangeMs(deadline, at("2026-08-03T15:33:00.000Z"))).toBe(300_000);
  expect(paymentDeadlinePhase(deadline, at("2026-08-03T15:38:00.000Z"))).toBe("ended");
  expect(nextPaymentDeadlineChangeMs(deadline, at("2026-08-03T15:38:00.000Z"))).toBeNull();
});

it("WP-2423 M19: a phone that is slow does not keep offering the card after the server stops", () => {
  const deadline = paymentDeadlineFrom(
    "2026-08-03T15:30:00.000Z",
    "2026-08-03T15:29:00.000Z",
    at("2026-08-03T15:19:00.000Z"),
  );
  if (deadline === null) throw new Error("deadline");
  expect(paymentDeadlinePhase(deadline, at("2026-08-03T15:19:00.000Z"))).toBe("warning");
  expect(paymentDeadlinePhase(deadline, at("2026-08-03T15:20:00.000Z"))).toBe("ended");
});

it("WP-2423 M19: keeps the earlier deadline (a stock cutoff before the payment window)", () => {
  const window = paymentDeadlineFrom("2026-08-03T15:30:00.000Z", undefined, 0);
  const stock = paymentDeadlineFrom("2026-08-03T15:10:00.000Z", undefined, 0);
  expect(earlierPaymentDeadline(window, stock)).toBe(stock);
  expect(earlierPaymentDeadline(stock, window)).toBe(stock);
  expect(earlierPaymentDeadline(null, window)).toBe(window);
  expect(paymentDeadlineFrom("later", undefined, 0)).toBeNull();
});
