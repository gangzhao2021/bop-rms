// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { DiningRoundsProvider, useDiningRounds } from "./DiningRounds.js";
import { click, mount, until } from "./dom-test-kit.fixture.js";
import { ClockStyleContext, StoreTimeZoneContext, type ClockStyle } from "./StoreTime.js";

// b40 review: "You can chase it again at {time}" used the device's locale and time zone, so a
// device set to another zone said the wrong hour, and Tables mixed "2:05\u00a0PM" with "2:05\u00a0p.m.".
// It now says the Store's time in the screen's style, as every other time on that screen.

const csrf = "A".repeat(43);
const orderReference = "01909968-0000-7000-8000-000000000001";
// 05:05 UTC is 2:05\u00a0p.m. in Tokyo (no daylight time), whatever zone this machine is in.
const exactMinute = "2026-11-21T05:05:00.000Z";

afterEach(() => {
  document.body.innerHTML = "";
});

function Chase() {
  const rounds = useDiningRounds();
  return (
    <button
      type="button"
      onClick={() =>
        rounds?.chaseItem({
          orderItemReference: "01909968-0000-7000-8000-000000000201",
          displayName: "TEST dumplings",
        } as never)
      }
    >
      Chase
    </button>
  );
}

async function chasedTooSoon(style: ClockStyle, retryAt = exactMinute) {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).includes("/merchant/dining/chase")
      ? new Response(JSON.stringify({ error: "dining_chase_too_soon", retryAt }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
      : new Response("{}", { status: 503 }),
  );
  const { container } = await mount(
    <ClockStyleContext.Provider value={style}>
      <StoreTimeZoneContext.Provider value="Asia/Tokyo">
        <DiningRoundsProvider
          orderReference={orderReference}
          csrf={csrf}
          refreshKey="1"
          fetcher={fetcher}
        >
          <Chase />
        </DiningRoundsProvider>
      </StoreTimeZoneContext.Provider>
    </ClockStyleContext.Provider>,
  );
  await click(container.querySelector("button"));
  await until(() => container.textContent?.includes("chased a moment ago") === true);
  return container.querySelector(".dining-rounds__status")?.textContent ?? "";
}

it("on Tables, says when a round can be chased again in the Store's time, as guests read it", async () => {
  expect(await chasedTooSoon("Guest")).toBe(
    "This round was chased a moment ago. You can chase it again at 2:05\u00a0p.m.",
  );
});

it("on Orders, says it in the back office's style, still in the Store's time", async () => {
  expect(await chasedTooSoon("Staff")).toBe(
    "This round was chased a moment ago. You can chase it again at 14:05.",
  );
});

// Batch 42 (v15: retryAt 15:04:47Z read "10:04\u00a0a.m.", and a chase at 10:04:10 was refused again):
// a time with seconds is shown as the next whole minute, so staff are never told a time that is
// still too soon; a time on the minute stays as it is.
it("rounds a chase-again time with seconds up to the next minute, never down", async () => {
  expect(await chasedTooSoon("Guest", "2026-11-21T05:04:47.000Z")).toBe(
    "This round was chased a moment ago. You can chase it again at 2:05\u00a0p.m.",
  );
  document.body.innerHTML = "";
  expect(await chasedTooSoon("Staff", "2026-11-21T05:04:00.001Z")).toBe(
    "This round was chased a moment ago. You can chase it again at 14:05.",
  );
  document.body.innerHTML = "";
  expect(await chasedTooSoon("Staff", "2026-11-21T05:04:00.000Z")).toBe(
    "This round was chased a moment ago. You can chase it again at 14:04.",
  );
});
