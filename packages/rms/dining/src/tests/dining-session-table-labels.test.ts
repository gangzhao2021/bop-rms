import { expect, it, vi } from "vitest";
import { listDiningSessionTableLabels } from "../infrastructure/persistence/dining-table-store.js";

const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };

it("WP-2423 Q2: reads the current table label of many sessions in one scoped query", async () => {
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(async (sql) =>
    sql.startsWith("SELECT set_config")
      ? { rows: [], rowCount: 1 }
      : {
          rows: [
            { session_id: id(10), label: "T4" },
            { session_id: id(11), label: "Patio 2" },
            { session_id: id(12), label: "bad\u0000label" },
          ],
          rowCount: 3,
        },
  );
  const labels = await listDiningSessionTableLabels({ query }, scope, [id(10), id(11), id(12)]);
  expect([...labels]).toEqual([
    [id(10), "T4"],
    [id(11), "Patio 2"],
  ]);
  expect(query.mock.calls[0]?.[1]).toEqual([id(1), id(2)]);
  expect(query.mock.calls[1]?.[1]).toEqual([id(1), id(2), [id(10), id(11), id(12)]]);
  // A session that was not asked for is a scope failure, not data.
  query.mockResolvedValueOnce({ rows: [], rowCount: 1 }).mockResolvedValueOnce({
    rows: [{ session_id: id(99), label: "T9" }],
    rowCount: 1,
  });
  await expect(listDiningSessionTableLabels({ query }, scope, [id(10)])).rejects.toThrow();
  expect((await listDiningSessionTableLabels({ query }, scope, [])).size).toBe(0);
});
