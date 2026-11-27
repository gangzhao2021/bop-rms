import { expect, it } from "vitest";
import { createPostgresCurrentWorkforceMfaSource } from "../infrastructure/persistence/current-workforce-mfa-source.js";
const id = (n: number) => "01909975-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T12:15:00.000Z";
function fixture(patch = {}) {
  const row = {
    actor_id: id(1),
    status: "TotpVerified",
    provider_evidence_id: id(2),
    verified_at: new Date(at),
    reset_at: null,
    version: 1,
    ...patch,
  };
  const calls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [row] };
    },
  };
  const query = { actorReference: id(1), observedAt: at };
  return { tx, query, calls };
}
it("reads verified MFA with a retained shared lock and no credentials", async () => {
  const f = fixture();
  const read = createPostgresCurrentWorkforceMfaSource({ authorize: async () => true });
  const result = await read(f.tx, f.query);
  expect(result.verifiedAt).toBe(at);
  expect(result.providerEvidenceReference).toBe(id(2));
  expect(f.calls[0]).toContain("FOR SHARE");
  expect(Object.keys(result).sort()).toEqual([
    "actorReference",
    "providerEvidenceReference",
    "resetAt",
    "status",
    "verifiedAt",
    "version",
  ]);
});
it.each([
  { actor_id: id(9) },
  { provider_evidence_id: null },
  { verified_at: new Date("2026-09-13T12:15:00.001Z") },
  { reset_at: new Date("2026-09-13T12:15:00.001Z") },
  { version: 0 },
])("rejects mismatched or invalid owner facts %j", async (patch) => {
  const f = fixture(patch);
  await expect(
    createPostgresCurrentWorkforceMfaSource({ authorize: async () => true })(f.tx, f.query),
  ).rejects.toThrow();
});
it("refuses authorization loss after a read", async () => {
  const f = fixture();
  let count = 0;
  await expect(
    createPostgresCurrentWorkforceMfaSource({
      authorize: async () => ++count === 1,
    })(f.tx, f.query),
  ).rejects.toThrow();
  expect(count).toBe(2);
});
it("returns reset status without inventing a verified time", async () => {
  const f = fixture({ status: "ResetRequired", verified_at: null, reset_at: new Date(at) });
  const result = await createPostgresCurrentWorkforceMfaSource({ authorize: async () => true })(
    f.tx,
    f.query,
  );
  expect(result.status).toBe("ResetRequired");
  expect(result.verifiedAt).toBeNull();
});
