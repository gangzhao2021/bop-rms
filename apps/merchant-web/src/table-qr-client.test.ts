import { describe, expect, it, vi } from "vitest";
import { createTableQrClient, TableQrClientError } from "./table-qr-client.js";

const id = (n: number) => "0190aa11-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const row = {
  tableReference: id(1),
  stableLabel: "Table 5",
  areaCode: "MAIN",
  aggregateVersion: 2,
  seated: false,
  codeState: "None",
  issuedAt: null,
  validUntil: null,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("2026-11-01: staff add, rename and retire their Store's tables", () => {
  it("adds a table with its name and seats and reads the new row", async () => {
    const fetcher = vi.fn(async () => json(200, { status: "Applied", item: row }));
    const client = createTableQrClient("csrf", fetcher);
    await expect(
      client.manage({
        action: "Add",
        label: "Table 5",
        capacity: 4,
        operationReference: id(9),
      }),
    ).resolves.toMatchObject({ stableLabel: "Table 5", codeState: "None" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/merchant/dining/table-qr/tables");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "Add",
      operationReference: id(9),
      label: "Table 5",
      capacity: 4,
    });
  });
  it("names the refusals staff can act on", async () => {
    const refused = (status: number, error: string) =>
      createTableQrClient("csrf", async () => json(status, { error })).manage({
        action: "Retire",
        table: { ...row, codeState: "None" },
        operationReference: id(9),
      });
    await expect(refused(409, "dining_table_name_taken")).rejects.toMatchObject({
      code: "NameTaken",
    });
    await expect(refused(409, "dining_table_seated")).rejects.toMatchObject({ code: "Seated" });
    await expect(refused(409, "dining_table_qr_changed")).rejects.toMatchObject({
      code: "Changed",
    });
    await expect(refused(400, "dining_table_invalid")).rejects.toBeInstanceOf(TableQrClientError);
  });
});

describe("Batch 58: Print all codes is one sheet for every table the page lists", () => {
  const sheetReply = () =>
    json(200, { fileName: "table-qr-codes-2026-11-24.html", html: "<!doctype html><p></p>" });
  it("sends up to 500 tables in one request", async () => {
    const fetcher = vi.fn(async () => sheetReply());
    const all = Array.from({ length: 500 }, (_, i) => id(i + 1));
    await expect(createTableQrClient("csrf", fetcher).sheet(all)).resolves.toMatchObject({
      fileName: "table-qr-codes-2026-11-24.html",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(
      (JSON.parse(String(init.body)) as { tableReferences: string[] }).tableReferences,
    ).toHaveLength(500);
  });
  it("reads a sheet larger than 20 MB (500 codes are about 17 MB)", async () => {
    const html = "<!doctype html>" + "x".repeat(24_000_000);
    const fetcher = vi.fn(async () =>
      json(200, { fileName: "table-qr-codes-2026-11-24.html", html }),
    );
    await expect(createTableQrClient("csrf", fetcher).sheet([id(1)])).resolves.toMatchObject({
      fileName: "table-qr-codes-2026-11-24.html",
    });
  });
  it("names too many tables as its own refusal, not an outage", async () => {
    const fetcher = vi.fn(async () => json(413, { error: "dining_table_qr_too_many" }));
    await expect(createTableQrClient("csrf", fetcher).sheet([id(1)])).rejects.toMatchObject({
      code: "TooMany",
    });
    const unsent = vi.fn(async () => sheetReply());
    await expect(
      createTableQrClient("csrf", unsent).sheet(Array.from({ length: 501 }, (_, i) => id(i + 1))),
    ).rejects.toMatchObject({ code: "TooMany" });
    expect(unsent).not.toHaveBeenCalled();
  });
});
