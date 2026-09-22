import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDiningSessionCloseClient } from "./dining-session-close-client.js";
import { DiningSessionCloseAction } from "./DiningSessionCloseAction.js";
import type { DiningProgress } from "./dining-progress-client.js";
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = (action: "Begin" | "Finalize" = "Begin") => ({
  operationReference: id(1),
  diningSessionReference: id(2),
  expectedSessionVersion: 4,
  action,
});
const response = (phase = "Closing", extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status: "AlreadyApplied", sessionVersion: 5, phase, ...extra }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it.each(["Begin", "Finalize"] as const)(
  "retries immutable %s with exact phase and version",
  async (action) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(action === "Begin" ? "Closing" : "Closed"));
    const input = command(action),
      op = createDiningSessionCloseClient(fetcher).prepare(input);
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
it.each([{ action: "Cancel" }, { expectedSessionVersion: 0 }, { actorReference: id(9) }])(
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
    createDiningSessionCloseClient(vi.fn(async () => response("Closing", change)))
      .prepare(command())
      .execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
const view: DiningProgress = {
  orderReference: id(3),
  tableLabel: "T1",
  orderVersion: 3,
  currentOrderVersion: 4,
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
  expect(render()).toContain("Begin session closing");
  expect(render()).toContain("disabled");
  expect(render({ sessionPhase: "Closing" })).toContain("Finalize session closing");
  expect(render({ sessionPhase: "Closed" })).toBe("");
  expect(render({ closureStatus: "Open" })).toContain("Begin session closing");
  expect(render({ closureStatus: "Open", sessionPhase: "Closing" })).toContain(
    "Finalize session closing",
  );
});
