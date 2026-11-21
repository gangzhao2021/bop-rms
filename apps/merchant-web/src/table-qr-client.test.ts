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
