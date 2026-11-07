// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PauseOrderingControl, pauseChain } from "./PauseOrderingControl.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";

const id = (n: number) => "01a4d700-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const now = "2026-11-06T23:00:00.000Z";
const first = {
  closureReference: id(10),
  effectiveFrom: "2026-11-06T22:45:00.000Z",
  effectiveUntil: "2026-11-06T23:03:00.000Z",
  serviceModes: null,
};
// Staff pressed "Pause 15 more min": a second pause runs on from the first one's end.
const extension = {
  closureReference: id(11),
  effectiveFrom: "2026-11-06T22:59:00.000Z",
  effectiveUntil: "2026-11-06T23:18:00.000Z",
  serviceModes: null,
};
const hours = {
  configurationSource: "StoreOverride",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveUntil: null,
  businessDayStartLocalTime: "04:00:00",
  weeklySchedule: [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({ isoWeekday, intervals: [] })),
  exceptions: [],
};
function state(activePauses: readonly unknown[], expectedVersion: number) {
  return {
    screenId: "STORE-HOURS-SERVICE",
    storeReference: id(3),
    configurationReference: id(4),
    timeZone: "America/Toronto",
    enabledServiceModes: ["DineIn", "Pickup"],
    observedAt: now,
    expectedVersion,
    activePauses,
    hours,
  };
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(now)));
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("WP-2423 M30 review: after 15 more minutes the control shows the chained end and Resume ends both pauses", async () => {
  let pauses: readonly (typeof first)[] = [first, extension];
  let version = 7;
  const posted: Record<string, unknown>[] = [];
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return json(state(pauses, version));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posted.push(body);
    if (body.expectedVersion !== version) return new Response(null, { status: 409 });
    version += 1;
    const ended = (body.content as { pauseOperationReference?: string }).pauseOperationReference;
    pauses = pauses.filter((pause) => pause.closureReference !== ended);
    return json({ status: "Applied", resultingVersion: version });
  }) as typeof fetch;
  const { container } = await mount(
    <PauseOrderingControl csrf={"a".repeat(43)} storeReference={id(3)} fetcher={fetcher} />,
  );
  await settle();
  // 18:18 in Toronto: the end of the extension, not the first pause's 18:03, and no warning yet.
  expect(container.textContent).toContain("Ordering paused until 18:18");
  expect(container.textContent).not.toContain("18:03");
  expect(buttonNamed(container, "Pause 15 more min")).toBeUndefined();

  await click(buttonNamed(container, "Resume"));
  await settle(10);
  expect(posted.map((body) => [body.command, body.expectedVersion, body.content])).toEqual([
    ["ResumeService", 7, { pauseOperationReference: id(10) }],
    ["ResumeService", 8, { pauseOperationReference: id(11) }],
  ]);
  expect(pauses).toEqual([]);
  expect(buttonNamed(container, "Pause ordering")).toBeDefined();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("WP-2423 M30 review: 15 more minutes runs on from the chained end, once the end is near", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T23:14:00.000Z"));
  const posted: Record<string, unknown>[] = [];
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST")
      return json({ ...state([first, extension], 3), observedAt: "2026-11-06T23:00:00.000Z" });
    posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ status: "Applied", resultingVersion: 4 });
  }) as typeof fetch;
  const { container } = await mount(
    <PauseOrderingControl csrf={"a".repeat(43)} storeReference={id(3)} fetcher={fetcher} />,
  );
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("18:18");
  await click(buttonNamed(container, "Pause 15 more min"));
  await settle();
  expect(posted[0]?.content).toEqual({
    effectiveUntil: "2026-11-06T23:33:00.000Z",
    serviceModes: null,
  });
});

it("WP-2423 M30 review: the chain is every pause overlapping from now, to the latest end", () => {
  const at = Date.parse(now);
  expect(pauseChain([], at)).toBeNull();
  expect(pauseChain([first, extension], at)).toEqual({
    until: extension.effectiveUntil,
    pauses: [first, extension],
    serviceModes: null,
  });
  // A pause already over is not part of it.
  expect(pauseChain([first], Date.parse("2026-11-06T23:04:00.000Z"))).toBeNull();
  const pickup = { ...extension, serviceModes: ["Pickup"] as const };
  const dineIn = { ...first, serviceModes: ["DineIn"] as const };
  expect(pauseChain([pickup, dineIn], at)?.serviceModes).toEqual(["DineIn", "Pickup"]);
});
