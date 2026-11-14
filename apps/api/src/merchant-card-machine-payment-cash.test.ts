import { describe, expect, it } from "vitest";
import { parseCardMachinePaymentCommand } from "./merchant-card-machine-payment.js";

const ref = (n: number) => "01a7e561-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = (extra: Record<string, unknown> = {}) => ({
  operationReference: ref(1),
  orderReference: ref(2),
  orderBatchReference: ref(3),
  expectedTotalMinor: "2243",
  slipReference: null,
  takenAt: null,
  ...extra,
});
const invalid = (value: unknown) =>
  expect(() => parseCardMachinePaymentCommand(value)).toThrowError(
    expect.objectContaining({ code: "CARD_MACHINE_INPUT_INVALID" }) as unknown as Error,
  );

describe("counter payment command (WP-2423 M52)", () => {
  it("takes the cash handed over, or none for the card machine", () => {
    expect(parseCardMachinePaymentCommand(command()).tenderedMinor).toBeNull();
    expect(parseCardMachinePaymentCommand(command({ tenderedMinor: "5000" })).tenderedMinor).toBe(
      "5000",
    );
    // An explicit null is the card machine too.
    expect(
      parseCardMachinePaymentCommand(command({ tenderedMinor: null })).tenderedMinor,
    ).toBeNull();
  });

  it("refuses a cash amount that is not whole cents, zero, or comes with a card slip", () => {
    for (const tenderedMinor of ["0", "-5", "12.5", 5000, ""]) invalid(command({ tenderedMinor }));
    invalid(command({ tenderedMinor: "5000", slipReference: "AUTH 1" }));
  });
});
