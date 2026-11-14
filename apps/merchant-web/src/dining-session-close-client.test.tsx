import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDiningSessionCloseClient } from "./dining-session-close-client.js";
import { DiningSessionCloseAction } from "./DiningSessionCloseAction.js";
import type { DiningProgress } from "./dining-progress-client.js";
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = (action: "Begin" | "Cancel" | "Finalize" = "Begin") => ({
  operationReference: id(1),
  diningSessionReference: id(2),
  expectedSessionVersion: 4,
  action,
});
const once = { delaysMs: [], recheckTimeoutMs: 1000 };
const response = (phase = "Closing", extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status: "AlreadyApplied", sessionVersion: 5, phase, ...extra }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it.each(["Begin", "Cancel", "Finalize"] as const)(
  "retries immutable %s with exact phase and version",
  async (action) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        response({ Begin: "Closing", Cancel: "Active", Finalize: "Closed" }[action]),
      );
    const input = command(action),
      op = createDiningSessionCloseClient(fetcher, once).prepare(input);
    input.expectedSessionVersion = 9;
    await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "OutcomeUnknown" });
    await expect(op.execute("A".repeat(43))).resolves.toMatchObject({
      status: "AlreadyApplied",
      sessionVersion: 5,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/dining/closing");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(command(action));
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
  },
);
it.each([{ action: "Reopen" }, { expectedSessionVersion: 0 }, { actorReference: id(9) }])(
  "rejects invalid authority/action %j",
  (change) => {
    expect(() =>
      createDiningSessionCloseClient().prepare({ ...command(), ...change } as ReturnType<
        typeof command
      >),
    ).toThrow();
  },
);
it.each([
  { phase: "Closed" },
  { sessionVersion: 6 },
  { status: "Committed" },
  { secret: "private" },
])("rejects mismatched receipt %j", async (change) => {
  await expect(
    createDiningSessionCloseClient(
      vi.fn(async () => response("Closing", change)),
      once,
    )
      .prepare(command())
      .execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
const view: DiningProgress = {
  orderReference: id(3),
  tableLabel: "T1",
  orderVersion: 3,
  currentOrderVersion: 4,
  chaseDish: false,
  sessionVersion: 4,
  diningSessionReference: id(2),
  sessionPhase: "Active",
  tableAssignmentVersion: 1,
  closureStatus: "Closed",
  closureVersion: 1,
  phase: "Fulfilled",
  observedAt: "2026-09-20T10:00:00.000Z",
  items: [],
};
const render = (change: Partial<DiningProgress> = {}) =>
  renderToStaticMarkup(
    <DiningSessionCloseAction
      view={{ ...view, ...change }}
      csrf={"A".repeat(43)}
      locked={false}
      onBusy={() => undefined}
      onClosed={() => undefined}
    />,
  );
it("uses owner phase to offer each confirmed step", () => {
  expect(render()).toContain("Start checkout");
  expect(render()).toContain("disabled");
  expect(render({ sessionPhase: "Closing" })).toContain("Close the table");
  expect(render({ sessionPhase: "Closed" })).toBe("");
  expect(render({ closureStatus: "Open" })).toContain("Start checkout");
  expect(render({ closureStatus: "Open", sessionPhase: "Closing" })).toContain("Close the table");
});

it("b13: the order page's close steps use table words, never dining session terms", () => {
  // v15 b12 live: "Finish closing this dining session … Finalize session closing" on the English
  // order page, while every other staff screen says "Close the table".
  for (const phase of ["Active", "Closing"] as const) {
    const html = render({ sessionPhase: phase });
    expect(html).not.toMatch(/dining session|session clos|Finalize/iu);
  }
  expect(render({ sessionPhase: "Closing" })).toContain(
    "I confirm the guests have left and the table can be closed",
  );
  expect(render()).toContain("I confirm the guests have finished ordering");
});

it("WP-2423: a lost Finalize answer is re-checked with the same operation", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValueOnce(response("Closed"));
  await expect(
    createDiningSessionCloseClient(fetcher, { delaysMs: [0], recheckTimeoutMs: 1000 })
      .prepare(command("Finalize"))
      .execute("A".repeat(43)),
  ).resolves.toMatchObject({ status: "AlreadyApplied", phase: "Closed" });
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
});

it("v15 b11: a table with a dish still to serve is refused as not ready (said), not as changed", async () => {
  const refused = (error: string) =>
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error }), {
        status: 409,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
  await expect(
    createDiningSessionCloseClient(refused("dining_session_not_ready"), once)
      .prepare(command("Finalize"))
      .execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "NotReady" });
  await expect(
    createDiningSessionCloseClient(refused("dining_session_changed"), once)
      .prepare(command("Finalize"))
      .execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "Conflict" });
});
