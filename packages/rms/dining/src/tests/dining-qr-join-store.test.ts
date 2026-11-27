import { describe, expect, it } from "vitest";
import { loadDiningSessionsPhones } from "../infrastructure/persistence/dining-qr-join-store.js";

const id = (value: number) => `018f7500-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const row = (session: number, participant: number, minute: number) => ({
  session_id: id(session),
  participant_id: id(participant),
  status: "Active",
  joined_at: `2026-11-03T12:${String(minute).padStart(2, "0")}:00.000Z`,
  removed: false,
});
const transaction = (found: readonly Record<string, unknown>[]) => {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  return {
    queries,
    tx: {
      query: async (text: string, values: readonly unknown[]) => {
        queries.push({ text, values });
        return { rows: text.includes("dining_participant p") ? found : [] };
      },
    } as never,
  };
};

describe("loadDiningSessionsPhones", () => {
  it("numbers each Session's phones from 1 in one read", async () => {
    const { tx, queries } = transaction([row(10, 11, 1), row(10, 12, 2), row(20, 21, 3)]);
    const phones = await loadDiningSessionsPhones(tx, scope, [id(10), id(20), id(30)], {
      excludeAdmissions: [id(40)],
    });
    expect(phones.get(id(10))?.map((phone) => phone.phoneNumber)).toEqual([1, 2]);
    expect(phones.get(id(20))?.map((phone) => phone.phoneNumber)).toEqual([1]);
    expect(phones.get(id(30))).toBeUndefined();
    expect(queries).toHaveLength(2);
    expect(queries[1]?.values[3]).toEqual([id(10), id(20), id(30)]);
    expect(queries[1]?.values[4]).toEqual([id(40)]);
    expect(queries[1]?.values[5]).toBe(601);
  });

  it("reads nothing for a page with no open table", async () => {
    const { tx, queries } = transaction([]);
    expect((await loadDiningSessionsPhones(tx, scope, [])).size).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("refuses a Session past the 200 phone bound, as the one-Session read does", async () => {
    const found = Array.from({ length: 201 }, (_, index) => row(10, 100 + index, 1));
    await expect(
      loadDiningSessionsPhones(transaction(found).tx, scope, [id(10), id(20)]),
    ).rejects.toThrow();
  });
});
