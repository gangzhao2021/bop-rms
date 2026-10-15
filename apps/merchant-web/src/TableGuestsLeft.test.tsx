import { expect, it, vi } from "vitest";
import { guestsLeftRoundText } from "./TableGuestsLeft.js";
import {
  createTableClosePlanClient,
  parseTableClosePlan,
  resolvesOnConfirm,
  type TableCloseRound,
} from "./dining-table-close-plan-client.js";

const id = (n: number) => "01a4d500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
const round = (overrides: Partial<TableCloseRound>): TableCloseRound => ({
  orderBatchReference: id(20),
  sequence: 4,
  state: "PaidNotSent",
  openItemCount: 2,
  startedItemCount: 0,
  readyItemCount: 0,
  cancellableItemReferences: [],
  refund: { method: "Online", amountMinor: "1130" },
  cancelsAt: null,
  ...overrides,
});
const wire = {
  orderReference: id(3),
  diningSessionReference: id(2),
  orderVersion: 19,
  observedAt: "2026-10-15T19:00:00.000Z",
  rounds: [
    {
      orderBatchReference: id(20),
      sequence: 4,
      state: "PaidNotSent",
      openItemCount: 1,
      startedItemCount: 0,
      readyItemCount: 0,
      cancellableItemReferences: [],
      refund: { method: "Online", amountMinor: "1130" },
      cancelsAt: null,
    },
    {
      orderBatchReference: id(21),
      sequence: 1,
      state: "AlreadyRefunded",
      openItemCount: 1,
      startedItemCount: 0,
      readyItemCount: 0,
      cancellableItemReferences: [],
      refund: { method: "Online", amountMinor: "0" },
      cancelsAt: null,
    },
  ],
  totals: { onlineMinor: "1130", cardMachineMinor: "0" },
  closeBlockers: [],
};

it("DEC-TABLE-CLOSE-GUESTS-LEFT: words each round for staff, with amounts and no internal codes", () => {
  const now = Date.parse("2026-10-15T19:00:00.000Z");
  const texts = [
    guestsLeftRoundText(round({}), "America/Toronto", now),
    guestsLeftRoundText(
      round({ refund: { method: "CardMachine", amountMinor: "593" } }),
      "America/Toronto",
      now,
    ),
    guestsLeftRoundText(round({ state: "AlreadyRefunded" }), "America/Toronto", now),
    guestsLeftRoundText(
      round({ state: "NotPaid", refund: null, cancelsAt: "2026-10-15T19:20:00.000Z" }),
      "America/Toronto",
      now,
    ),
    guestsLeftRoundText(
      round({
        state: "PartlyStarted",
        refund: null,
        startedItemCount: 1,
        cancellableItemReferences: [id(30)],
      }),
      "America/Toronto",
      now,
      "450",
    ),
    guestsLeftRoundText(round({ state: "BeingMade", refund: null }), "America/Toronto", now),
    guestsLeftRoundText(
      round({
        state: "RefundOnCardMachine",
        refund: { method: "CardMachine", amountMinor: "593" },
      }),
      "America/Toronto",
      now,
    ),
  ];
  expect(texts[0]).toBe(
    "Round 4: paid $11.30 online but never sent to the kitchen. It will be cancelled and the guest refunded.",
  );
  expect(texts[1]).toContain("refund it on the card machine");
  expect(texts[2]).toContain("already refunded in full");
  expect(texts[3]).toContain("cancelled automatically at 15:20");
  expect(texts[4]).toContain("$4.50 refunded");
  expect(texts[5]).toContain("mark them served");
  expect(texts.join(" ")).not.toContain("CAD");
  expect(texts[6]).toContain("Refund $5.93 on the card machine");
  // v15 DEMO-02 round 16: accepted, refunded in full on the card machine item by item already.
  const refunded = guestsLeftRoundText(
    round({
      state: "NotStarted",
      openItemCount: 1,
      refund: { method: "CardMachine", amountMinor: "0" },
    }),
    "America/Toronto",
    now,
  );
  expect(refunded).toBe(
    "Round 4: 1 item not started in the kitchen, already refunded in full. It will be cancelled; nothing is left to refund.",
  );
  texts.push(refunded);
  for (const text of texts) expect(text).not.toMatch(/[0-9a-f]{8}-|GUEST_LEFT|PaidNotSent|Batch/u);
});

it("DEC-TABLE-CLOSE-GUESTS-LEFT: parses the plan strictly and resolves rounds with the existing cancellations", async () => {
  const plan = parseTableClosePlan(wire, { order: id(3), session: id(2) });
  expect(plan.rounds.map(resolvesOnConfirm)).toEqual([true, true]);
  expect(() => parseTableClosePlan(wire, { order: id(9), session: id(2) })).toThrow();
  expect(() =>
    parseTableClosePlan(
      { ...wire, rounds: [{ ...wire.rounds[0], refund: null }] },
      { order: id(3), session: id(2) },
    ),
  ).toThrow();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "Cancelled" }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "order_version_conflict" }), { status: 409 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "full_sign_in_required" }), { status: 403 }),
    )
    .mockRejectedValueOnce(new Error("offline"));
  const client = createTableClosePlanClient(fetcher);
  const first = plan.rounds[0] as TableCloseRound;
  expect(await client.resolve(plan, first, id(40), csrf)).toBe("Done");
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/orders/cancel");
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    orderReference: id(3),
    orderBatchReference: id(20),
    expectedOrderVersion: 19,
    operationReference: id(40),
    reasonCode: "GUEST_LEFT",
  });
  expect(await client.resolve(plan, first, id(41), csrf)).toBe("Changed");
  expect(await client.resolve(plan, first, id(42), csrf)).toBe("FullSignInRequired");
  expect(await client.resolve(plan, first, id(42), csrf)).toBe("Unknown");
  // Lines not started of a round partly made go through the item cancellation.
  const items = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
  await createTableClosePlanClient(items).resolve(
    plan,
    round({ state: "PartlyStarted", refund: null, cancellableItemReferences: [id(30)] }),
    id(43),
    csrf,
  );
  expect(items.mock.calls[0]?.[0]).toBe("/merchant/orders/cancel-items");
  expect(JSON.parse(String(items.mock.calls[0]?.[1]?.body))).toMatchObject({
    orderItemReferences: [id(30)],
    reasonCode: "GUEST_LEFT",
  });
});

it("WP-2423 B759: the plan carries the close evaluation's reasons, strictly", () => {
  const expected = { order: id(3), session: id(2) };
  expect(
    parseTableClosePlan({ ...wire, closeBlockers: ["REFUND_PENDING"] }, expected).closeBlockers,
  ).toEqual(["REFUND_PENDING"]);
  const missing: Record<string, unknown> = { ...wire };
  delete missing.closeBlockers;
  expect(() => parseTableClosePlan(missing, expected)).toThrow();
  expect(() => parseTableClosePlan({ ...wire, closeBlockers: ["not a code"] }, expected)).toThrow();
});

it("WP-2423: started items are worded by kitchen readiness (ready to serve vs being made)", () => {
  const now = Date.parse("2026-10-15T19:00:00.000Z");
  const text = (overrides: Partial<TableCloseRound>, preview: string | null = null) =>
    guestsLeftRoundText(round({ refund: null, ...overrides }), "America/Toronto", now, preview);
  // v15: the kitchen marked the only open item ready; it is not "being made" any more.
  expect(
    text({ state: "BeingMade", openItemCount: 1, startedItemCount: 1, readyItemCount: 1 }),
  ).toBe("Round 4: 1 item ready to serve. Serve them, or mark them served on the Orders page.");
  expect(
    text({ state: "BeingMade", openItemCount: 3, startedItemCount: 3, readyItemCount: 1 }),
  ).toContain("2 items being made and 1 ready to serve.");
  expect(
    text({ state: "BeingMade", openItemCount: 2, startedItemCount: 2, readyItemCount: 0 }),
  ).toContain("2 items already being made.");
  // Paid on the card machine with an item not started yet.
  expect(
    text({ state: "BeingMade", openItemCount: 3, startedItemCount: 1, readyItemCount: 1 }),
  ).toContain("2 items being made or paid on the card machine and 1 ready to serve.");
  expect(
    text(
      {
        state: "PartlyStarted",
        openItemCount: 2,
        startedItemCount: 1,
        readyItemCount: 1,
        cancellableItemReferences: [id(30)],
      },
      "450",
    ),
  ).toBe(
    "Round 4: 1 item not started will be cancelled and $4.50 refunded. 1 item ready to serve: serve them, or mark them served on the Orders page.",
  );
});

it("WP-2423: a plan claiming more ready items than started is refused", () => {
  const value = { ...wire, rounds: wire.rounds.map((round) => ({ ...round, readyItemCount: 1 })) };
  expect(() => parseTableClosePlan(value, { order: id(3), session: id(2) })).toThrow();
});
