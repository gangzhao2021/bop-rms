import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDiningServeReadyClient,
  DINING_SERVE_READY_MAX_LINES,
} from "./dining-serve-ready-client.js";
import {
  DiningServeReadyAction,
  DiningServeReadyActions,
  readyToServe,
  serveReadySummary,
} from "./DiningServeReadyAction.js";
import { parseDiningProgress } from "./dining-progress-client.js";

const id = (n: number) => "01909988-2222-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
const command = (count = 2) => ({
  operationReference: id(1),
  orderReference: id(2),
  expectedOrderVersion: 4,
  expectedSessionVersion: 2,
  expectedTableAssignmentVersion: 3,
  lines: Array.from({ length: count }, (_, n) => ({
    orderItemReference: id(10 + n),
    quantity: 1,
    expectedItemServiceVersion: 0,
  })),
});
const answer = (
  outcomes: string[],
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  new Response(
    JSON.stringify({
      operationReference: id(1),
      served: outcomes.filter((o) => o === "Served").length,
      alreadyServed: outcomes.filter((o) => o === "AlreadyServed").length,
      changed: outcomes.filter((o) => o === "Changed").length,
      failed: outcomes.filter((o) => o === "Failed").length,
      lines: outcomes.map((outcome, n) => ({ orderItemReference: id(10 + n), outcome })),
      ...extra,
    }),
    {
      headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    },
  );

it("sends one batch and retries an unknown result with the identical request", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValueOnce(answer(["Served", "Served"]));
  const raw = command();
  const operation = createDiningServeReadyClient(fetcher).prepare(raw);
  raw.expectedOrderVersion = 9;
  await expect(operation.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(await operation.execute(csrf)).toMatchObject({ served: 2, failed: 0 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/dining/serve-ready");
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
    operationReference: id(1),
    expectedOrderVersion: 4,
  });
});

it("maps refusals and keeps unverifiable answers unknown", async () => {
  const op = (response: Response) =>
    createDiningServeReadyClient(vi.fn<typeof fetch>().mockResolvedValue(response))
      .prepare(command())
      .execute(csrf);
  await expect(op(new Response("x", { status: 403 }))).rejects.toMatchObject({
    code: "PermissionDenied",
  });
  await expect(op(new Response("x", { status: 404 }))).rejects.toMatchObject({
    code: "NotAvailable",
  });
  await expect(op(new Response("x", { status: 503 }))).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  // Counts that do not match the lines, another request's reference, or a missing line.
  await expect(op(answer(["Served", "Served"], { served: 1 }))).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  await expect(
    op(answer(["Served", "Served"], { operationReference: id(5) })),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(op(answer(["Served"]))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(
    op(answer(["Served", "Served"], {}, { "cache-control": "max-age=60" })),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});

it.each([
  ["no lines", { ...command(), lines: [] }],
  ["too many lines", command(DINING_SERVE_READY_MAX_LINES + 1)],
  ["a repeated line", { ...command(), lines: [command().lines[0], command().lines[0]] }],
  ["a zero quantity", { ...command(), lines: [{ ...command().lines[0], quantity: 0 }] }],
  ["a bad reference", { ...command(), operationReference: "x" }],
])("refuses to prepare %s", (_label, body) => {
  expect(() => createDiningServeReadyClient().prepare(body as never)).toThrow();
});

it("summarises the result in staff words without internal codes", () => {
  const summary = (served: number, alreadyServed: number, changed: number, failed: number) =>
    serveReadySummary({ served, alreadyServed, changed, failed, lines: [] });
  expect(summary(53, 0, 0, 0)).toBe("All 53 items marked served.");
  expect(summary(48, 0, 5, 0)).toBe(
    "48 served. 5 could not be served because they changed (cancelled, partly served or the table moved). Check them and try again.",
  );
  expect(summary(50, 2, 0, 1)).toBe(
    "50 served. 2 were already marked served by someone else. 1 could not be served right now. It is still ready; try again.",
  );
  expect(summary(0, 1, 0, 0)).toBe("1 was already marked served by someone else.");
  for (const text of [summary(1, 1, 1, 1), summary(3, 3, 3, 3)])
    expect(text).not.toMatch(/[a-z]+_[a-z]+|[A-Z]{3,}|[0-9a-f]{8}-/u);
});

const item = (n: number, round: number, extra: Record<string, unknown> = {}) => ({
  orderItemReference: id(100 + n),
  orderBatchReference: id(200 + round),
  displayName: "Dish " + n,
  batchSequence: round,
  itemOrdinal: n,
  phase: "Ready",
  orderedQuantity: 2,
  deliveredQuantity: 0,
  remainingQuantity: 2,
  itemServiceVersion: 0,
  ...extra,
});
const view = (items: unknown[], extra: Record<string, unknown> = {}) =>
  parseDiningProgress(
    {
      orderReference: id(2),
      orderVersion: 4,
      sessionVersion: 2,
      diningSessionReference: id(55),
      sessionPhase: "Active",
      tableAssignmentVersion: 3,
      closureStatus: "Open",
      closureVersion: 0,
      currentOrderVersion: 4,
      tableLabel: "T1",
      phase: "Ready",
      observedAt: "2026-09-20T11:00:00.000Z",
      items,
      ...extra,
    },
    id(2),
  );
const text = (html: string) =>
  html
    .replaceAll("<!-- -->", "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ");
const renderActions = (current: ReturnType<typeof view>) =>
  text(
    renderToStaticMarkup(
      <DiningServeReadyActions
        view={current}
        csrf={csrf}
        locked={false}
        onBusy={() => undefined}
        onDone={() => undefined}
      />,
    ),
  );

it("offers one action per round with 2+ ready items, and the table action across rounds", () => {
  const current = view([
    item(1, 1),
    item(2, 1),
    item(3, 1, { phase: "Fulfilled", deliveredQuantity: 2, remainingQuantity: 0 }),
    item(4, 2),
    item(5, 2, { phase: "InProgress" }),
    item(6, 3),
    item(7, 3),
  ]);
  expect(readyToServe(current).map((entry) => entry.displayName)).toEqual([
    "Dish 1",
    "Dish 2",
    "Dish 4",
    "Dish 6",
    "Dish 7",
  ]);
  const html = renderActions(current);
  expect(html).toContain("Serve all 5 ready items");
  expect(html).toContain("Serve all 2 ready items in round 1");
  expect(html).toContain("Serve all 2 ready items in round 3");
  // Round 2 has one ready item: it is served on its own.
  expect(html).not.toContain("in round 2");
  // One confirmation stating how many items are marked served, listing them.
  expect(html).toContain("Mark 5 items served for table T1?");
  expect(html).toContain("Mark 2 items served for round 1 at table T1?");
  expect(html).toContain("2 × Dish 6 · round 3");
  expect(html.match(/Mark 5 items served(?!\s+for)/gu)).toHaveLength(1);
  expect(html).not.toContain(id(101));
});

it("shows no action with fewer than two ready items, or at a closed or closing table", () => {
  expect(renderActions(view([item(1, 1), item(2, 1, { phase: "Accepted" })]))).toBe("");
  expect(renderActions(view([item(1, 1), item(2, 1)], { sessionPhase: "Closing" }))).toBe("");
  expect(
    renderActions(view([item(1, 1), item(2, 1)], { closureStatus: "Closed", closureVersion: 1 })),
  ).toBe("");
  // All ready items in one round: the round action alone, no duplicate table action.
  const single = renderActions(view([item(1, 1), item(2, 1)]));
  expect(single).toContain("Serve all 2 ready items in round 1");
  expect(single.match(/Serve all/gu)).toHaveLength(1);
});

it("serves at most the request limit and says what is left", () => {
  const current = view(
    Array.from({ length: DINING_SERVE_READY_MAX_LINES + 3 }, (_, n) =>
      item(n + 1, 1, { itemOrdinal: 1 }),
    ),
  );
  const html = text(
    renderToStaticMarkup(
      <DiningServeReadyAction
        view={current}
        ready={readyToServe(current)}
        scope={{ kind: "Table" }}
        csrf={csrf}
        locked={false}
        onBusy={() => undefined}
        onDone={() => undefined}
      />,
    ),
  );
  expect(html).toContain(`Serve the first 100 of 103 ready items`);
  expect(html).toContain("Mark 100 items served for table T1?");
  expect(html).toContain("The other 3 ready items stay as they are");
});
