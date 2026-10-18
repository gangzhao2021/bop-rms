import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDiningOrderCloseClient,
  DiningOrderCloseClientError,
} from "./dining-order-close-client.js";
import { closeReasonTexts } from "./dining-close-reasons.js";
import { DiningOrderCloseAction } from "./DiningOrderCloseAction.js";
import type { DiningProgress } from "./dining-progress-client.js";
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = () => ({
  operationReference: id(1),
  orderReference: id(2),
  expectedOrderVersion: 4,
  expectedClosureVersion: 0,
  reasonCode: "ORDER_COMPLETED",
});
// One send, no automatic re-check (the re-check is tested on its own below).
const once = { delaysMs: [], recheckTimeoutMs: 1000 };
const response = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      status: "AlreadyCommitted",
      closedOrderVersion: 4,
      closureVersion: 1,
      ...extra,
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
it("keeps original intent on unknown-result retry even if caller mutates input", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response());
  const input = command();
  const op = createDiningOrderCloseClient(fetcher, once).prepare(input);
  input.expectedOrderVersion = 99;
  await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(op.execute("A".repeat(43))).resolves.toMatchObject({
    status: "AlreadyCommitted",
    closureVersion: 1,
  });
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(command()));
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/orders/close");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
});
it.each([
  { expectedClosureVersion: -1 },
  { expectedOrderVersion: 0 },
  { actorReference: id(9) },
  { reasonCode: "bad reason" },
])("rejects invalid/authority-injected command %j", (change) => {
  expect(() => createDiningOrderCloseClient().prepare({ ...command(), ...change })).toThrow();
});
it.each([
  { closureVersion: 2 },
  { closedOrderVersion: 5 },
  { status: "Created" },
  { secret: "private" },
])("treats mismatched success as unknown %j", async (change) => {
  await expect(
    createDiningOrderCloseClient(
      vi.fn(async () => response(change)),
      once,
    )
      .prepare(command())
      .execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it.each([
  [403, "PermissionDenied"],
  [409, "Conflict"],
  [503, "OutcomeUnknown"],
])("handles HTTP %s without echoing its body", async (status, code) => {
  await expect(
    createDiningOrderCloseClient(
      vi.fn(async () => new Response("private", { status: Number(status) })),
      once,
    )
      .prepare(command())
      .execute("A".repeat(43)),
  ).rejects.toMatchObject({ code });
});
const view: DiningProgress = {
  orderReference: id(2),
  tableLabel: "T1",
  orderVersion: 3,
  currentOrderVersion: 4,
  sessionVersion: 2,
  diningSessionReference: id(55),
  sessionPhase: "Active",
  tableAssignmentVersion: 1,
  closureStatus: "Open",
  closureVersion: 0,
  phase: "Fulfilled",
  observedAt: "2026-09-20T10:00:00.000Z",
  items: [],
};
const render = (change: Partial<DiningProgress> = {}, locked = false) =>
  renderToStaticMarkup(
    <DiningOrderCloseAction
      view={{ ...view, ...change }}
      csrf={"A".repeat(43)}
      locked={locked}
      onBusy={() => undefined}
      onClosed={() => undefined}
    />,
  );
it("requires confirmation and explains that the session stays open", () => {
  const html = render();
  expect(html).toContain("I confirm this order is complete");
  expect(html).toContain("disabled");
  expect(html).toContain("The dining session stays open.");
});
it.each([{ closureStatus: "Closed" as const }, { phase: "Ready" }])(
  "does not offer closure outside completed Open orders %j",
  (change) => {
    expect(render(change)).toBe("");
  },
);

it("WP-2423 B759: a refusal is told apart from a missing permission, with what is outstanding", async () => {
  const csrfToken = "A".repeat(43);
  const refused = async (status: number, body: unknown) => {
    const client = createDiningOrderCloseClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status })),
      once,
    );
    return client
      .prepare(command())
      .execute(csrfToken)
      .then(
        () => null,
        (error: unknown) => error as DiningOrderCloseClientError,
      );
  };
  const notReady = await refused(409, { error: "order_not_ready", reasons: ["REFUND_PENDING"] });
  expect(notReady?.code).toBe("NotReady");
  expect(notReady?.reasons).toEqual(["REFUND_PENDING"]);
  expect((await refused(409, { error: "order_version_conflict" }))?.code).toBe("Conflict");
  expect((await refused(403, { error: "order_close_permission_denied" }))?.code).toBe(
    "PermissionDenied",
  );
  const texts = closeReasonTexts(["REFUND_PENDING", "EXECUTION_NOT_FINAL", "SOMETHING_NEW"]);
  expect(texts).toHaveLength(3);
  expect(texts[0]).toMatch(/refund is still being made/u);
  for (const text of texts) expect(text).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
});

it("WP-2423: a lost answer is re-checked with the same operation and reports the real result", async () => {
  const fast = { delaysMs: [0, 0], recheckTimeoutMs: 1000 };
  // Timed out / dropped twice, then the server answers the same operation: already closed.
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValueOnce(new Response("busy", { status: 503 }))
    .mockResolvedValueOnce(response());
  await expect(
    createDiningOrderCloseClient(fetcher, fast).prepare(command()).execute("A".repeat(43)),
  ).resolves.toMatchObject({ status: "AlreadyCommitted", closureVersion: 1 });
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const call of fetcher.mock.calls) expect(call[1]?.body).toBe(JSON.stringify(command()));
  // A re-check that is refused reports the refusal, not an unknown result.
  const refused = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "order_not_ready", reasons: ["REFUND_PENDING"] }), {
        status: 409,
      }),
    );
  await expect(
    createDiningOrderCloseClient(refused, fast).prepare(command()).execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "NotReady", reasons: ["REFUND_PENDING"] });
  // Unknown only when every re-check is lost too; nothing beyond the bounded re-checks is sent.
  const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
  await expect(
    createDiningOrderCloseClient(offline, fast).prepare(command()).execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(offline).toHaveBeenCalledTimes(3);
  // Leaving the screen stops the re-checks.
  const controller = new AbortController();
  const stopped = vi.fn<typeof fetch>().mockImplementation(async () => {
    controller.abort();
    throw new Error("offline");
  });
  await expect(
    createDiningOrderCloseClient(stopped, { delaysMs: [1000], recheckTimeoutMs: 1000 })
      .prepare(command())
      .execute("A".repeat(43), controller.signal),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(stopped).toHaveBeenCalledOnce();
});
