import { describe, expect, it, vi } from "vitest";
import { newPhones } from "./TablePhones.js";
import { createTablePhonesClient, parseTablePhones } from "./table-phones-client.js";

const id = (n: number) => "01a4d500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
/** Synthetic, TEST-only: table with three phones, phone 2 taken off the table by staff. */
const wire = () => ({
  diningSessionReference: id(1),
  paused: false,
  phones: [
    {
      participantReference: id(11),
      phoneNumber: 1,
      joinedAt: "2026-10-28T18:00:00.000Z",
      left: false,
      removed: false,
    },
    {
      participantReference: id(12),
      phoneNumber: 2,
      joinedAt: "2026-10-28T18:05:00.000Z",
      left: true,
      removed: true,
    },
    {
      participantReference: id(13),
      phoneNumber: 3,
      joinedAt: "2026-10-28T18:20:00.000Z",
      left: false,
      removed: false,
    },
  ],
  rounds: [
    { orderBatchReference: id(21), phoneNumber: 1 },
    { orderBatchReference: id(22), phoneNumber: null },
  ],
});

describe("WP-2423 item 8 ⑤ phones at the table", () => {
  it("reads the phones in join order and which phone sent each round", () => {
    const state = parseTablePhones(wire());
    expect(state.phones.map((phone) => [phone.phoneNumber, phone.removed])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(state.rounds.get(id(21))).toBe(1);
    expect(state.rounds.get(id(22))).toBeNull();
  });

  it("refuses numbering out of join order, a removed phone still at the table, or extra fields", () => {
    const shuffled = wire();
    (shuffled.phones[0] as { phoneNumber: number }).phoneNumber = 2;
    expect(() => parseTablePhones(shuffled)).toThrow();
    const stillHere = wire();
    (stillHere.phones[1] as { left: boolean }).left = false;
    expect(() => parseTablePhones(stillHere)).toThrow();
    expect(() => parseTablePhones({ ...wire(), guestName: "x" })).toThrow();
  });

  it("points out a phone for 10 minutes after it joined, never one that left", () => {
    const { phones } = parseTablePhones(wire());
    const at = (iso: string) => Date.parse(iso);
    expect(newPhones(phones, at("2026-10-28T18:25:00.000Z")).map((p) => p.phoneNumber)).toEqual([
      3,
    ]);
    expect(newPhones(phones, at("2026-10-28T18:30:00.000Z"))).toEqual([]);
    expect(newPhones(phones, at("2026-10-28T18:29:59.000Z")).map((p) => p.phoneNumber)).toEqual([
      3,
    ]);
  });

  it("sends staff intent only: pause, resume and remove with their own references", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(wire()), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
    const client = createTablePhonesClient(fetcher);
    await client.setPaused(csrf, {
      diningSessionReference: id(1),
      paused: true,
      operationReference: id(30),
    });
    await client.remove(csrf, {
      diningSessionReference: id(1),
      participantReference: id(13),
      operationReference: id(31),
    });
    const bodies = fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/dining/sessions/qr-join");
    expect(bodies).toEqual([
      { action: "Pause", diningSessionReference: id(1), operationReference: id(30) },
      {
        action: "Remove",
        diningSessionReference: id(1),
        participantReference: id(13),
        operationReference: id(31),
      },
    ]);
  });
});
