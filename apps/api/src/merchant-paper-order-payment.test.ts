import { expect, it } from "vitest";
import { CardMachinePaymentCommandError } from "./merchant-card-machine-payment.js";
import {
  paperPaidAtRefusal,
  paperPaidAtRefusalBody,
  recordPaperOrderPayment,
} from "./merchant-paper-order-payment.js";

const placed = {
  orderReference: "01909995-0000-7000-8000-000000000001",
  orderBatchReference: "01909995-0000-7000-8000-000000000002",
  totalMinor: "2718",
};
const payment = {
  operationReference: "01909995-0000-7000-8000-000000000003",
  tender: "CardMachine" as const,
  slipReference: null,
  takenAt: "2026-11-11T14:00:00.000Z",
};
const recorded = {
  status: "Recorded" as const,
  orderReference: placed.orderReference,
  orderBatchReference: placed.orderBatchReference,
  amountMinor: "2718",
  recordingReason: "RecordedAfterOutage" as const,
  takenAt: payment.takenAt,
  recordedAt: "2026-11-11T14:20:00.000Z",
  cash: null,
  acceptance: "Accepted" as const,
};
const auth = { sessionCookie: "cookie", csrf: "csrf" };

it("DEC-PAPER-ORDER-NEVER-RELEASED: a paper payment the system failed to record is tried again with the same operation in the same request", async () => {
  const commands: unknown[] = [];
  const waits: number[] = [];
  let calls = 0;
  const answer = await recordPaperOrderPayment(
    async (input) => {
      commands.push(input.command);
      calls++;
      if (calls === 1) throw new Error("connection terminated");
      if (calls === 2) throw new CardMachinePaymentCommandError("CARD_MACHINE_UNAVAILABLE");
      return recorded;
    },
    auth,
    placed,
    payment,
    undefined,
    { delaysMs: [300, 1_200], wait: async (ms) => void waits.push(ms) },
  );
  expect(answer).toEqual({
    payment: {
      status: "Recorded",
      amountMinor: "2718",
      recordingReason: "RecordedAfterOutage",
      takenAt: payment.takenAt,
      recordedAt: recorded.recordedAt,
      acceptance: "Accepted",
    },
  });
  expect(calls).toBe(3);
  expect(waits).toEqual([300, 1_200]);
  // One payment: every try sends the same operation and amount.
  expect(new Set(commands.map((command) => JSON.stringify(command))).size).toBe(1);
});

it("answers a refusal at once and an outage only after its tries, never as an error of the order", async () => {
  let calls = 0;
  const refused = await recordPaperOrderPayment(
    async () => {
      calls++;
      throw new CardMachinePaymentCommandError("CARD_MACHINE_TAKEN_BEFORE_RECORDS");
    },
    auth,
    placed,
    payment,
    undefined,
    { delaysMs: [300, 1_200], wait: async () => undefined },
  );
  expect(refused).toEqual({ paymentError: "taken_before_records" });
  expect(calls).toBe(1);
  calls = 0;
  const reported: unknown[] = [];
  const down = await recordPaperOrderPayment(
    async () => {
      calls++;
      throw new Error("database is down");
    },
    auth,
    placed,
    payment,
    (error) => reported.push(error),
    { delaysMs: [300, 1_200], wait: async () => undefined },
  );
  expect(down).toEqual({ paymentError: "card_machine_payment_unavailable" });
  expect(calls).toBe(3);
  expect(reported).toHaveLength(1);
});

// DEC-PAPER-SEND-IDEMPOTENT (b11): a paper slip already recorded with another order is a refusal
// staff act on (named by that order), never "the system is unavailable, send again".
it("answers a paper slip already recorded with the order that holds it", async () => {
  const held = new CardMachinePaymentCommandError("CARD_MACHINE_SLIP_ALREADY_RECORDED");
  held.slipOrderNumber = "29";
  for (const route of ["counter_order", "staff_round"] as const)
    expect(paperPaidAtRefusal(held, route)).toEqual([409, "slip_already_recorded"]);
  expect(paperPaidAtRefusalBody(held, "slip_already_recorded")).toEqual({
    error: "slip_already_recorded",
    orderNumber: "29",
  });
  const answer = await recordPaperOrderPayment(
    async () => {
      throw held;
    },
    { sessionCookie: "c", csrf: "x" },
    {
      orderReference: "01909995-0000-7000-8000-000000000001",
      orderBatchReference: "01909995-0000-7000-8000-000000000002",
      totalMinor: "735",
    },
    {
      operationReference: "01909995-0000-7000-8000-000000000003",
      tender: "CardMachine",
      slipReference: "TESTSLIP6D",
      takenAt: "2026-11-11T17:00:00.000Z",
    },
  );
  expect(answer).toEqual({ paymentError: "slip_already_recorded", paymentSlipOrderNumber: "29" });
});
