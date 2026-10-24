import { expect, it, vi } from "vitest";
import {
  createCompensationReconciliationClient,
  parseCompensationView,
} from "./compensation-reconciliation-client.js";
const id = (n: number) => "0190fa84-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z",
  csrf = "a".repeat(43),
  headers = { "content-type": "application/json", "cache-control": "no-store" };
const model = {
  caseVersion: 2,
  caseState: "Open",
  refund: { amountMinor: "1130", currencyCode: "CAD", confirmedAt: at },
  acknowledgmentRecorded: false,
};
it("parses confirmed money exactly and rejects inconsistent closure and extra evidence", () => {
  expect(parseCompensationView(model)).toEqual(model);
  for (const value of [
    { ...model, caseState: "Closed" },
    { ...model, privateEvidence: "hidden" },
    { ...model, refund: { ...model.refund, amountMinor: "9223372036854775808" } },
    { ...model, refund: { ...model.refund, amountMinor: "0" } },
  ])
    expect(() => parseCompensationView(value)).toThrow();
});
it("queries only exact IDs in POST body with bounded private transport", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(model), { status: 200, headers }));
  const client = createCompensationReconciliationClient(fetcher);
  expect(await client.query({ orderReference: id(1), caseReference: id(2) }, csrf)).toEqual(model);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/operations/compensations/query",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      body: JSON.stringify({ orderReference: id(1), caseReference: id(2) }),
    }),
  );
});
it("snapshots retry identity and keeps it after unknown response", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("{}", { status: 503, headers }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "ReconciliationRecorded", replayed: true, reconciledAt: at }),
        { status: 202, headers },
      ),
    );
  const command = {
      orderReference: id(1),
      caseReference: id(2),
      receiptReference: id(3),
      auditReference: id(4),
      expectedCaseVersion: 2,
    },
    intent = createCompensationReconciliationClient(fetcher).prepare(command);
  command.expectedCaseVersion = 9;
  await expect(intent.execute(csrf)).rejects.toThrow();
  expect(await intent.execute(csrf)).toEqual({ replayed: true, reconciledAt: at });
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).expectedCaseVersion).toBe(2);
});
it("rejects bad csrf and untrusted response without inventing confirmation", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(model), { status: 200 }));
  const client = createCompensationReconciliationClient(fetcher);
  await expect(
    client.query({ orderReference: id(1), caseReference: id(2) }, "bad"),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    client.query({ orderReference: id(1), caseReference: id(2) }, csrf),
  ).rejects.toThrow();
});
