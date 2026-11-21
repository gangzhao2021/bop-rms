import { expect, it, vi } from "vitest";
import {
  createDiningServeReadyClient,
  DINING_SERVE_READY_MAX_LINES,
} from "./dining-serve-ready-client.js";
import { serveReadySummary } from "./dining-serve-ready.js";

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
