import { expect, it, vi } from "vitest";
import {
  createDiningHostTransferClient,
  type DiningHostSelection,
} from "./dining-host-transfer-client.js";
const id = (n: number) => "0190fa43-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-21T04:00:00.000Z",
  csrf = "a".repeat(43);
const source: DiningHostSelection = {
  diningSessionReference: id(1),
  sessionVersion: 3,
  phase: "Active",
  hostParticipantReference: id(2),
  observedAt: at,
  participants: [
    { participantReference: id(2), joinedAt: at, isHost: true },
    { participantReference: id(3), joinedAt: at, isHost: false },
  ],
};
const receipt = {
  status: "AlreadyApplied",
  operationReference: id(4),
  diningSessionReference: id(1),
  previousHostParticipantReference: id(2),
  hostParticipantReference: id(3),
  sessionVersion: 4,
  transferredAt: at,
};
const response = (value: unknown) =>
  Response.json(value, { headers: { "cache-control": "no-store" } });
it("binds current participant selection to requested session", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(source));
  expect(await createDiningHostTransferClient(fetch).selection(id(1), csrf)).toEqual(source);
  fetch.mockResolvedValue(response({ ...source, diningSessionReference: id(99) }));
  await expect(createDiningHostTransferClient(fetch).selection(id(1), csrf)).rejects.toThrow();
});
it.each(["duplicate", "overflow", "host", "future"])(
  "rejects invalid selection %s",
  async (kind) => {
    let participants = [...source.participants];
    if (kind === "duplicate") participants = [...participants, ...participants];
    if (kind === "overflow")
      participants = Array.from({ length: 101 }, () => source.participants[0]).filter(
        (p) => p !== undefined,
      );
    if (kind === "host") participants = participants.map((p) => ({ ...p, isHost: !p.isHost }));
    if (kind === "future")
      participants = participants.map((p) => ({ ...p, joinedAt: "2026-09-22T04:00:00.000Z" }));
    const fetch = vi.fn(async () => response({ ...source, participants }));
    await expect(createDiningHostTransferClient(fetch).selection(id(1), csrf)).rejects.toThrow();
  },
);
it("preserves one request after network loss and a later denial until original receipt recovered", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(new Response("", { status: 403 }))
    .mockResolvedValueOnce(response(receipt));
  const client = createDiningHostTransferClient(fetch),
    op = client.prepare(source, id(3), id(4));
  await expect(op.execute(csrf)).rejects.toMatchObject({ code: "Unknown" });
  await expect(op.execute(csrf)).rejects.toMatchObject({ code: "Unknown" });
  expect(await op.execute(csrf)).toMatchObject({ status: "AlreadyApplied", sessionVersion: 4 });
  expect(new Set(fetch.mock.calls.map(([, init]) => init?.body)).size).toBe(1);
});
it("keeps an initially known permission refusal distinct", async () => {
  const fetch = vi.fn(async () => new Response("", { status: 403 }));
  await expect(
    createDiningHostTransferClient(fetch).prepare(source, id(3), id(4)).execute(csrf),
  ).rejects.toMatchObject({ code: "Denied" });
});
it.each([
  { operationReference: id(99) },
  { hostParticipantReference: id(99) },
  { sessionVersion: 5 },
  { transferredAt: "2026-09-20T04:00:00.000Z" },
  { privateEvidence: "private" },
])("rejects mismatched receipt %j as unknown", async (change) => {
  const fetch = vi.fn(async () => response({ ...receipt, ...change }));
  await expect(
    createDiningHostTransferClient(fetch).prepare(source, id(3), id(4)).execute(csrf),
  ).rejects.toMatchObject({ code: "Unknown" });
});
it("does not prepare current Host or absent participant", () => {
  for (const target of [id(2), id(99)])
    expect(() => createDiningHostTransferClient().prepare(source, target, id(4))).toThrow();
});
