import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantWorkforceAuthoritySource } from "./merchant-workforce-authority-source.js";
import {
  tenantContext,
  ACTOR,
  BRAND,
  STORE,
  AT,
  uuid,
} from "../../../packages/bop/permission/src/tests/current-policy.fixture.js";

function fixture() {
  const query = {
    tenantReference: uuid("90"),
    brandReference: BRAND,
    storeReference: STORE,
    actorReference: ACTOR,
    observedAt: AT,
    permissionCode: "payment.refund.approve",
  };
  const sql = vi.fn(async () => {
    throw new Error("unexpected owner read");
  });
  const tx = { query: sql } as unknown as ConsumerTransaction;
  return { query, tx, sql };
}
it.each(["tenantReference", "brandReference", "storeReference", "actorReference"] as const)(
  "rejects a context mismatch in %s before querying private owner facts",
  async (key) => {
    const f = fixture();
    const source = createMerchantWorkforceAuthoritySource({
      resolveContext: async () => ({
        tenantReference: f.query.tenantReference,
        context: tenantContext,
      }),
    });
    const candidate = { ...f.query, [key]: uuid("99") };
    await expect(source(f.tx, candidate)).rejects.toThrow("WORKFORCE_AUTHORITY_UNAVAILABLE");
    expect(f.sql).not.toHaveBeenCalled();
  },
);
it("rejects stale context and caller role or MFA claims", async () => {
  const f = fixture();
  const resolveContext = vi.fn(async () => ({
    tenantReference: f.query.tenantReference,
    context: tenantContext,
  }));
  const source = createMerchantWorkforceAuthoritySource({ resolveContext });
  await expect(
    source(f.tx, {
      ...f.query,
      observedAt: "2026-07-28T12:30:00.001Z",
    }),
  ).rejects.toThrow("WORKFORCE_AUTHORITY_UNAVAILABLE");
  expect(f.sql).not.toHaveBeenCalled();
  resolveContext.mockClear();
  await expect(source(f.tx, { ...f.query, activeRoleCodes: ["Owner"] })).rejects.toThrow();
  await expect(source(f.tx, { ...f.query, recentMfaAt: AT })).rejects.toThrow();
  expect(resolveContext).not.toHaveBeenCalled();
});
