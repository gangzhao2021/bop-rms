import { beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantRoundBusinessDates,
  knownRoundBusinessDate,
  withOptionalRead,
} from "./merchant-round-business-date.js";

const doubles = vi.hoisted(() => ({ rounds: vi.fn(), today: vi.fn() }));
vi.mock("@rms/ordering", () => ({ listStoreOrderRoundSubmissions: doubles.rounds }));
vi.mock("./merchant-business-day-window.js", () => ({
  createMerchantBusinessDayWindows: () => ({ today: doubles.today }),
}));
const id = (n: number) => "01a4d400-0000-7000-8000-" + n.toString(16).padStart(12, "0");
// Toronto, business day starting 04:00: Thu Oct 15 starts 2026-10-15T08:00Z.
const today = { businessDate: "2026-10-15", startsAt: "2026-10-15T08:00:00.000Z" };
const opened = {
  initial: true,
  submittedAt: "2026-10-11T23:30:00.000Z",
  orderBusinessDate: "2026-10-11",
};
beforeEach(() => vi.resetAllMocks());

it("WP-2423 D4: the first round keeps the Order's date; a later round today is today's", () => {
  expect(knownRoundBusinessDate(opened, today)).toBe("2026-10-11");
  const later = { ...opened, initial: false };
  expect(knownRoundBusinessDate({ ...later, submittedAt: "2026-10-15T18:00:00.000Z" }, today)).toBe(
    "2026-10-15",
  );
  // 03:30 Toronto on Oct 15 is still Oct 14's business day: resolved at its own time.
  expect(
    knownRoundBusinessDate({ ...later, submittedAt: "2026-10-15T07:30:00.000Z" }, today),
  ).toBeNull();
  expect(
    knownRoundBusinessDate({ ...later, submittedAt: "2026-10-15T18:00:00.000Z" }, null),
  ).toBeNull();
});

function resolver() {
  const tx = {
    query: vi.fn<(sql: string) => Promise<unknown>>(async () => ({ rows: [], rowCount: 0 })),
  };
  const read = createMerchantRoundBusinessDates({
    persistence: { now: () => "2026-10-15T19:00:00.000Z" } as never,
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    timeZone: "America/Toronto",
    authorize: async () => true,
  });
  return { tx, read: (refs: string[]) => read(tx as never, refs) };
}

it("WP-2423 D4: resolves later rounds by the Store's business day, earlier ones at their own time", async () => {
  const { tx, read } = resolver();
  doubles.rounds.mockResolvedValue(
    new Map([
      [id(10), { ...opened, orderReference: id(9) }],
      [
        id(11),
        {
          ...opened,
          orderReference: id(9),
          initial: false,
          submittedAt: "2026-10-15T18:00:00.000Z",
        },
      ],
      [
        id(12),
        {
          ...opened,
          orderReference: id(9),
          initial: false,
          submittedAt: "2026-10-13T20:00:00.000Z",
        },
      ],
    ]),
  );
  doubles.today.mockImplementation(async (_tx: unknown, at: string) =>
    at === "2026-10-15T19:00:00.000Z" ? today : { businessDate: "2026-10-13", startsAt: "x" },
  );
  const dates = await read([id(10), id(11), id(12), id(11)]);
  expect(doubles.rounds.mock.calls[0]?.[2]).toEqual([id(10), id(11), id(12)]);
  expect(Object.fromEntries(dates)).toEqual({
    [id(10)]: "2026-10-11",
    [id(11)]: "2026-10-15",
    [id(12)]: "2026-10-13",
  });
  expect(doubles.today.mock.calls.map((call) => call[1])).toEqual([
    "2026-10-15T19:00:00.000Z",
    "2026-10-13T20:00:00.000Z",
  ]);
  expect(tx.query.mock.calls.map((call) => call[0])).toEqual([
    "SAVEPOINT merchant_round_business_date",
    "RELEASE SAVEPOINT merchant_round_business_date",
  ]);
});

it("WP-2423 D4: first rounds only need no business-day read; an unreadable day falls back", async () => {
  const { tx, read } = resolver();
  doubles.rounds.mockResolvedValue(new Map([[id(10), { ...opened, orderReference: id(9) }]]));
  expect(Object.fromEntries(await read([id(10)]))).toEqual({ [id(10)]: "2026-10-11" });
  expect(doubles.today).not.toHaveBeenCalled();
  expect(tx.query).not.toHaveBeenCalled();

  doubles.rounds.mockResolvedValue(
    new Map([
      [id(10), { ...opened, orderReference: id(9) }],
      [
        id(11),
        {
          ...opened,
          orderReference: id(9),
          initial: false,
          submittedAt: "2026-10-15T18:00:00.000Z",
        },
      ],
    ]),
  );
  doubles.today.mockRejectedValue(new Error("STORE_BUSINESS_DATE_UNAVAILABLE"));
  // The later round is left out; callers show the Order's own date.
  expect(Object.fromEntries(await read([id(10), id(11)]))).toEqual({ [id(10)]: "2026-10-11" });
  expect(tx.query.mock.calls.map((call) => call[0])).toEqual([
    "SAVEPOINT merchant_round_business_date",
    "ROLLBACK TO SAVEPOINT merchant_round_business_date",
    "RELEASE SAVEPOINT merchant_round_business_date",
  ]);
});

it("WP-2423 D4: an optional read returns its value, or the fallback after undoing its statements", async () => {
  const tx = { query: vi.fn<(sql: string) => Promise<unknown>>(async () => ({ rows: [] })) };
  await expect(withOptionalRead(tx, async () => "read", "fallback")).resolves.toBe("read");
  await expect(
    withOptionalRead(tx, () => Promise.reject(new Error("unavailable")), "fallback"),
  ).resolves.toBe("fallback");
});
