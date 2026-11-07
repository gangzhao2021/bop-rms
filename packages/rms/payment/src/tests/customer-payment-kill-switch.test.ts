import { expect, it, vi } from "vitest";
import { createFeatureControlDefinition, type KillSwitchDefinition } from "@bop/feature-control";
import {
  createCustomerPaymentKillSwitch,
  type CustomerPaymentKillSwitchOptions,
} from "../application/customer-payment-kill-switch.js";
import { parsePaymentInstant } from "../application/payment-intent-creation.js";
import { verifyPaymentProviderAdmission } from "../application/payment-kill-switch.js";
const id = (n: number) => "01902402-0000-7000-8000-" + String(n).padStart(12, "0");
const at = parsePaymentInstant("2026-09-11T00:00:00.000Z");
function setup() {
  let phase = "Inactive",
    guest = id(3),
    now: string = at;
  const scope = { brandReference: id(1), storeReference: id(2) };
  const definition = () =>
    createFeatureControlDefinition({
      controlId: id(4),
      key: "payment.provider.admission",
      version: 1,
      ownerReference: id(5),
      purposeCode: "PAYMENT_SAFETY",
      scope: { kind: "Store", ...scope },
      effectiveFrom: at,
      effectiveUntil: "2026-09-11T00:00:01.000Z",
      reviewAt: at,
      expiresAt: null,
      kind: "KillSwitch",
      defaultActive: true,
      mode: "BlockNew",
      inFlightPolicy: "AllowToComplete",
      recoveryPolicy: "Manual",
      recoveryStages: [],
      state: { phase },
    }) as KillSwitchDefinition;
  const authorize = vi.fn(async () => ({
    action: "CreatePaymentIntent" as const,
    ...scope,
    guestSessionReference: guest,
  }));
  const options: CustomerPaymentKillSwitchOptions = {
    scope,
    authorization: { authorize },
    definitions: {
      async loadCurrent() {
        return [definition()];
      },
    },
    clock: { now: () => now },
    rollout: { bucketForGuest: () => 0 },
  };
  const service = createCustomerPaymentKillSwitch(options, {
    paymentOperationReference: id(6),
    submissionReference: id(7),
  });
  const input = {
    ...scope,
    key: "payment.provider.admission" as const,
    action: "CreatePaymentIntent" as const,
    evaluatedAt: at,
  };
  return {
    options,
    service,
    input,
    authorize,
    definition,
    setPhase: (v: string) => {
      phase = v;
    },
    setGuest: (v: string) => {
      guest = v;
    },
    setNow: (v: string) => {
      now = v;
    },
  };
}
it("allows current Guest admission and preserves the exact payment operation binding", async () => {
  const f = setup();
  expect(
    verifyPaymentProviderAdmission(await f.service.evaluate(f.input), f.input)?.inFlightPolicy,
  ).toBe("AllowToComplete");
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenCalledWith({
    action: "CreatePaymentIntent",
    paymentOperationReference: id(6),
    submissionReference: id(7),
    observedAt: at,
  });
  f.setPhase("Active");
  expect(verifyPaymentProviderAdmission(await f.service.evaluate(f.input), f.input)).toBeNull();
});
it("rejects wrong scope before resolving authorization", async () => {
  const f = setup();
  await expect(f.service.evaluate({ ...f.input, storeReference: id(99) })).rejects.toThrow(
    "customer payment safety unavailable",
  );
  expect(f.authorize).not.toHaveBeenCalled();
});
it("rejects revocation or Guest replacement during lookup", async () => {
  for (const replace of [false, true]) {
    const f = setup();
    f.options.definitions.loadCurrent = async () => {
      if (replace) f.setGuest(id(99));
      else f.options.authorization.authorize = async () => null;
      return [f.definition()];
    };
    await expect(f.service.evaluate(f.input)).rejects.toThrow(
      "customer payment safety unavailable",
    );
  }
});
it("does not accept a replacement Guest on a later evaluation", async () => {
  const f = setup();
  await f.service.evaluate(f.input);
  f.setGuest(id(99));
  await expect(f.service.evaluate(f.input)).rejects.toThrow("customer payment safety unavailable");
});
it("rejects expiry or clock regression while definitions are loading", async () => {
  for (const end of ["2026-09-11T00:00:01.000Z", "2026-09-10T23:59:59.999Z"]) {
    const f = setup();
    f.options.definitions.loadCurrent = async () => {
      f.setNow(end);
      return [f.definition()];
    };
    await expect(f.service.evaluate(f.input)).rejects.toThrow(
      "customer payment safety unavailable",
    );
  }
});
it("missing definitions produce no admission", async () => {
  const f = setup();
  f.options.definitions.loadCurrent = async () => [];
  expect(verifyPaymentProviderAdmission(await f.service.evaluate(f.input), f.input)).toBeNull();
});
