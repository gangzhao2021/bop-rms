import { describe, expect, it, vi } from "vitest";
import { createGuestBindingCredentialProvider } from "@bop/identity";
import { fixture, id, now } from "../test-support/customer-entry-composition-fixture.js";
import {
  createCustomerCartBindingComposition,
  type CustomerCartBindingCompositionOptions,
} from "./customer-cart-binding-composition.js";
function setup() {
  const f = fixture();
  const sessionRun = vi.fn(async (): Promise<never> => {
    throw new Error("synthetic private session driver");
  });
  const orderingRun = vi.fn(async (): Promise<never> => {
    throw new Error("unexpected Ordering transaction");
  });
  const append = vi.fn(async () => {
    throw new Error("unexpected Identity audit");
  });
  const audit = vi.fn(() => {
    throw new Error("unexpected Ordering audit");
  });
  const generateReference = vi.fn(() => id(900));
  const options: CustomerCartBindingCompositionOptions = {
    scope: { brandReference: id(1), storeReference: id(2) },
    session: f.options.session,
    sessionTransactions: { run: sessionRun },
    orderingTransactions: { run: orderingRun },
    identityAudit: { append },
    ordering: {
      policy: {
        policyVersionReference: id(901),
        policyDigest: "sha256:" + "a".repeat(64),
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86400,
        validFrom: now,
        validUntil: "2026-01-16T12:00:00.000Z",
      },
      sourceChannel: "Qr",
      generateReference,
      audit,
    },
    recovery: createGuestBindingCredentialProvider(new Uint8Array(32).fill(7)),
    preparationLifetimeSeconds: 300,
    now: () => now,
  };
  return { f, options, sessionRun, orderingRun, append, audit, generateReference };
}
describe("explicit Cart binding composition", () => {
  it("acquires no resources or credentials during construction", () => {
    const f = setup();
    const port = createCustomerCartBindingComposition(f.options);
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.keys(port)).toEqual(["prepare", "activate", "complete"]);
    for (const mock of [
      f.sessionRun,
      f.orderingRun,
      f.append,
      f.audit,
      f.generateReference,
      f.f.options.session.credentials.generateCredential,
    ])
      expect(mock).not.toHaveBeenCalled();
  });
  it.each([0, 901, NaN])(
    "rejects invalid preparation lifetime %s before effects",
    (preparationLifetimeSeconds) => {
      const f = setup();
      expect(() =>
        createCustomerCartBindingComposition({ ...f.options, preparationLifetimeSeconds }),
      ).toThrow();
      expect(f.sessionRun).not.toHaveBeenCalled();
      expect(f.orderingRun).not.toHaveBeenCalled();
    },
  );
  it.each(["prepare", "activate", "complete"] as const)(
    "rejects malformed %s without touching providers",
    async (action) => {
      const f = setup();
      await expect(
        createCustomerCartBindingComposition(f.options)[action]({} as never),
      ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
      expect(f.sessionRun).not.toHaveBeenCalled();
      expect(f.orderingRun).not.toHaveBeenCalled();
    },
  );
  it("bounds authorization dependency failure before target reservation or Audit", async () => {
    const f = setup();
    const error = await createCustomerCartBindingComposition(f.options)
      .prepare({
        operationReference: id(902),
        sessionCredential: "e".repeat(43),
        csrfCredential: "f".repeat(43),
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("private session driver");
    expect(f.sessionRun).toHaveBeenCalledOnce();
    for (const mock of [
      f.orderingRun,
      f.append,
      f.audit,
      f.generateReference,
      f.f.options.session.credentials.generateCredential,
    ])
      expect(mock).not.toHaveBeenCalled();
  });
});
