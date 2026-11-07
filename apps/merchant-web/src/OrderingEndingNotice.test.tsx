import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { timeLeftWords } from "./operations-alert-words.js";
import {
  ORDERING_ENDING_READ_MS,
  OrderingEndingLine,
  OrderingEndingNotice,
  loadOrderingEnding,
  orderingEndingWords,
  parseOrderingEnding,
  trackOrderingEnding,
  type OrderingEnding,
} from "./OrderingEndingNotice.js";

const T0 = Date.parse("2026-11-25T02:26:31.000Z");
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(T0 + hours * HOUR).toISOString();
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

afterEach(() => setLanguageForTest("en"));

describe('AGENTS.md "Warn before timeouts": what any staff member reads about ordering stopping', () => {
  it("accepts only the server's closed answer", () => {
    expect(parseOrderingEnding({ endsAt: null, support: null })).toBe(null);
    expect(parseOrderingEnding({ endsAt: inHours(23), support: null })).toEqual({
      endsAt: inHours(23),
      support: null,
    });
    const support = { phone: "+14165550100", testOnly: true };
    expect(parseOrderingEnding({ endsAt: inHours(23), support })?.support).toEqual(support);
    for (const bad of [
      null,
      [],
      { endsAt: null },
      { endsAt: null, support: null, active: [] },
      { endsAt: "tomorrow", support: null },
      { endsAt: inHours(23), support: { phone: "call us", testOnly: false } },
      { endsAt: inHours(23), support: { phone: "+14165550100" } },
    ])
      expect(() => parseOrderingEnding(bad)).toThrow("ORDERING_ENDING_UNAVAILABLE");
  });
  it("reads with no caching and refuses anything that is not its answer", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => answer({ endsAt: null, support: null }));
    await expect(loadOrderingEnding(fetcher)).resolves.toBe(null);
    expect(fetcher).toHaveBeenCalledWith(
      "/merchant/ordering-ending",
      expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin" }),
    );
    await expect(loadOrderingEnding(async () => answer({ error: "x" }, 503))).rejects.toThrow(
      "ORDERING_ENDING_UNAVAILABLE",
    );
    await expect(
      loadOrderingEnding(async () => new Response("<html>", { status: 200 })),
    ).rejects.toThrow("ORDERING_ENDING_UNAVAILABLE");
  });
  it("says how long is left, who can renew it and how to keep serving", () => {
    const words = orderingEndingWords(inHours(23), T0);
    expect(words.title).toBe("Ordering at this Store stops in 23 hours");
    expect(words.detail).toBe(
      "Only BOP support can renew it: call them now, or tell your manager. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.",
    );
    expect(orderingEndingWords(inHours(1), T0).title).toBe(
      "Ordering at this Store stops in 1 hour",
    );
    expect(orderingEndingWords(inHours(0.5), T0).title).toBe(
      "Ordering at this Store stops in 30 minutes",
    );
    expect(orderingEndingWords(new Date(T0 + 30_000).toISOString(), T0).title).toBe(
      "Ordering at this Store stops in less than a minute",
    );
    const stopped = orderingEndingWords(inHours(-1), T0);
    expect(stopped.title).toBe("Ordering at this Store has stopped");
    expect(stopped.detail).not.toContain("If it stops");
    expect(stopped.detail).toContain("your own POS or on paper");
  });
  it("says it in the Chinese too, with no internal words", () => {
    setLanguageForTest("zh-Hans");
    expect(timeLeftWords(23 * HOUR)).toBe("23小时");
    const words = orderingEndingWords(inHours(23), T0);
    expect(words.title).toBe("这家店的点单服务还有23小时就会停止");
    expect(words.detail).toContain("刷卡机");
    expect(orderingEndingWords(inHours(-1), T0).title).toBe("这家店的点单服务已经停止");
    for (const text of [words.title, words.detail])
      expect(text.match(/[A-Za-z]{2,}/gu)?.filter((word) => word !== "BOP") ?? []).toEqual([]);
  });
});

describe("the notice above the screen", () => {
  const ending = (support: { phone: string; testOnly: boolean } | null = null) => ({
    endsAt: inHours(23),
    support,
  });
  const line = (now = T0, support: { phone: string; testOnly: boolean } | null = null) =>
    renderToStaticMarkup(<OrderingEndingLine ending={ending(support)} now={now} />);
  it("says how long is left, once to a screen reader, in a section of its own", () => {
    const html = line();
    expect(html).toContain('aria-label="Ordering at this Store"');
    expect(html).toContain("Ordering at this Store stops in 23 hours");
    expect(html).toContain('role="alert">Ordering at this Store is about to stop<');
    // The announcement does not change with the countdown.
    expect(line(T0 + 2 * HOUR)).toContain("Ordering at this Store stops in 21 hours");
    expect(line(T0 + 2 * HOUR)).toContain('role="alert">Ordering at this Store is about to stop<');
  });
  it("offers the number only when there is one, and labels a test number", () => {
    expect(line()).not.toContain("tel:");
    const real = line(T0, { phone: "+14165550100", testOnly: false });
    expect(real).toContain('href="tel:+14165550100"');
    expect(real).toContain("Call BOP support: (416) 555-0100");
    expect(real).not.toContain("(test number)");
    expect(line(T0, { phone: "+14165550100", testOnly: true })).toContain("(test number)");
  });
  it("shows nothing before anything has been read, which is also the answer at 25 hours", () => {
    expect(renderToStaticMarkup(<OrderingEndingNotice />)).toBe("");
  });
});

describe("how the screen reads it", () => {
  beforeEach(() => vi.useFakeTimers({ now: T0 }));
  afterEach(() => vi.useRealTimers());
  const track = (load: (signal: AbortSignal) => Promise<OrderingEnding | null>, inView = true) => {
    const seen: (OrderingEnding | null)[] = [];
    const stop = trackOrderingEnding({
      load,
      onEnding: (value) => seen.push(value),
      inView: () => inView,
    });
    return { seen, stop };
  };
  const known: OrderingEnding = { endsAt: inHours(23), support: null };
  it("reads at once and then at most every five minutes", async () => {
    const load = vi.fn(async () => known);
    const { seen, stop } = track(load);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([known]);
    await vi.advanceTimersByTimeAsync(ORDERING_ENDING_READ_MS - 1000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2 * ORDERING_ENDING_READ_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("a read that fails says nothing: the screen keeps what it last knew", async () => {
    let reads = 0;
    const { seen, stop } = track(async () => {
      reads += 1;
      if (reads > 1) throw new Error("ORDERING_ENDING_UNAVAILABLE");
      return known;
    });
    await vi.advanceTimersByTimeAsync(2 * ORDERING_ENDING_READ_MS);
    expect(reads).toBe(3);
    expect(seen).toEqual([known]);
    stop();
  });
  it("hears of a renewal at the next read", async () => {
    let renewed = false;
    const { seen, stop } = track(async () => (renewed ? null : known));
    await vi.advanceTimersByTimeAsync(0);
    renewed = true;
    await vi.advanceTimersByTimeAsync(ORDERING_ENDING_READ_MS);
    expect(seen).toEqual([known, null]);
    stop();
  });
  it("does not read while the screen is out of view, apart from the first", async () => {
    const load = vi.fn(async () => known);
    const { stop } = track(load, false);
    await vi.advanceTimersByTimeAsync(3 * ORDERING_ENDING_READ_MS);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });
  it("says nothing of an answer that arrives after it was stopped", async () => {
    let answer: (value: OrderingEnding) => void = () => undefined;
    const { seen, stop } = track(() => new Promise((resolve) => (answer = resolve)));
    stop();
    answer(known);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });
});
