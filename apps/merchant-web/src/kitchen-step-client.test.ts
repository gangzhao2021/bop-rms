import { describe, expect, it, vi } from "vitest";
import { KitchenStepClientError, prepareKitchenStep } from "./kitchen-step-client.js";

const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "a".repeat(43);
const line = (n: number) => ({
  idempotencyKey: id(n),
  ticketReference: id(900),
  workItemReference: id(n + 100),
  orderItemReference: id(n + 200),
  optionReferences: null,
});
const replyLine = (n: number) => ({
  workItemReference: id(n + 100),
  orderItemReference: id(n + 200),
  ticketReference: id(900),
  outcome: "Finished",
  refusedReason: null,
  ticketVersion: "5",
  workItemVersion: "4",
  workItemStatus: "Completed",
  completedQuantity: 1,
  requiredQuantity: 1,
  acceptedAt: "2026-11-05T12:00:00.000Z",
  readyAt: "2026-11-05T12:00:00.000Z",
  dishesDone: null,
});
const reply = (lines: readonly unknown[]) =>
  new Response(
    JSON.stringify({
      projectionName: "kitchen_work_queue_v1",
      projectionPending: true,
      occurredAt: "2026-11-05T12:00:00.000Z",
      lines,
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
const prepared = (fetcher: typeof fetch, count = 1) =>
  prepareKitchenStep(
    {
      step: "Finish",
      storeReference: id(1),
      correlationReference: id(2),
      lines: Array.from({ length: count }, (_, n) => line(n + 1)),
    },
    fetcher,
  );

describe("DEC-KITCHEN-ONE-TAP: one tap, one immutable body", () => {
  it("names what was tapped and no versions; the same bytes go every time", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply([replyLine(1)]));
    const step = prepared(fetcher);
    await step.execute(csrf);
    await step.execute(csrf);
    const [first, second] = fetcher.mock.calls;
    expect(first?.[0]).toBe("/merchant/kitchen/step");
    expect(first?.[1]?.body).toBe(second?.[1]?.body);
    expect(String(first?.[1]?.body)).not.toMatch(/expected|actorReference/u);
    expect(JSON.parse(String(first?.[1]?.body))).toMatchObject({
      step: "Finish",
      storeReference: id(1),
      correlationReference: id(2),
    });
  });
  it("takes one to fifty lines", () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => prepared(fetcher, 0)).toThrow(KitchenStepClientError);
    expect(() => prepared(fetcher, 51)).toThrow(KitchenStepClientError);
    expect(() => prepared(fetcher, 50)).not.toThrow();
  });
  it.each([
    [401, "PermissionDenied"],
    [403, "PermissionDenied"],
    [400, "Invalid"],
    [404, "Invalid"],
    [413, "Invalid"],
    [409, "Busy"],
    [422, "Busy"],
    [503, "Busy"],
    [500, "OutcomeUnknown"],
  ])("reads a %i as %s, never as a permission problem unless it is one", async (status, code) => {
    const step = prepared(vi.fn<typeof fetch>(async () => new Response("{}", { status })));
    await expect(step.execute(csrf)).rejects.toMatchObject({ code });
  });
  it("treats a lost answer as unknown, so the same body goes again", async () => {
    const step = prepared(vi.fn<typeof fetch>(() => Promise.reject(new TypeError("lost"))));
    await expect(step.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  });
  it("reads the largest reply a tap can get", async () => {
    const lines = Array.from({ length: 50 }, (_, n) => ({
      ...replyLine(n + 1),
      dishesDone: Array.from({ length: 20 }, (_, k) => id(k + 300)),
    }));
    const result = await prepared(
      vi.fn<typeof fetch>(async () => reply(lines)),
      50,
    ).execute(csrf);
    expect(result.lines).toHaveLength(50);
    expect(result.lines[49]?.dishesDone).toHaveLength(20);
  });
  it("does not trust a reply about other work or with fewer lines", async () => {
    await expect(
      prepared(vi.fn<typeof fetch>(async () => reply([replyLine(7)]))).execute(csrf),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
    await expect(
      prepared(
        vi.fn<typeof fetch>(async () => reply([])),
        1,
      ).execute(csrf),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  });
  it("carries a refusal and a line left out as they are", async () => {
    const result = await prepared(
      vi.fn<typeof fetch>(async () =>
        reply([
          {
            ...replyLine(1),
            outcome: "Refused",
            refusedReason: "Cancelled",
            ticketVersion: null,
            workItemVersion: null,
            workItemStatus: null,
            completedQuantity: null,
            requiredQuantity: null,
            acceptedAt: null,
            readyAt: null,
          },
        ]),
      ),
    ).execute(csrf);
    expect(result.lines[0]).toMatchObject({ outcome: "Refused", refusedReason: "Cancelled" });
  });
});
