import { expect, it, vi } from "vitest";
import { createCustomerPaymentHandoff } from "../application/customer-payment-handoff.js";
import { createPaymentIntentCreationService } from "../application/payment-intent-creation-service.js";
import { harness, command, at, refs } from "./payment-intent-creation.fixture.js";
async function fixture() {
  const result = await createPaymentIntentCreationService(harness().ports).create(command());
  const loadCurrent = vi.fn().mockResolvedValue(result.record);
  let now = at;
  const outcome = result.record.providerOutcome;
  if (outcome?.kind !== "Snapshot") throw new Error("fixture invalid");
  const provider = {
    retrieve: vi.fn().mockResolvedValue({
      snapshot: outcome,
      clientSecret: outcome.providerIntentReference + "_secret_SYNTHETICONLY",
    }),
  };
  return {
    record: result.record,
    loadCurrent,
    provider,
    setTime(value: string) {
      now = value;
    },
    handoff: createCustomerPaymentHandoff({ now: () => now, loadCurrent, provider }),
  };
}
it("checks current owner access before and after retrieving ephemeral credential", async () => {
  const f = await fixture();
  const result = await f.handoff.retrieve(refs.operation);
  expect(Object.keys(result)).toEqual(["clientSecret"]);
  expect(f.loadCurrent).toHaveBeenCalledTimes(2);
  expect(f.provider.retrieve).toHaveBeenCalledTimes(1);
});
it("rejects revoked access before and during Provider retrieval", async () => {
  const before = await fixture();
  before.loadCurrent.mockResolvedValue(null);
  await expect(before.handoff.retrieve(refs.operation)).rejects.toMatchObject({
    code: "NOT_READY",
  });
  expect(before.provider.retrieve).not.toHaveBeenCalled();
  const during = await fixture();
  during.loadCurrent.mockResolvedValueOnce(during.record).mockResolvedValueOnce(null);
  await expect(during.handoff.retrieve(refs.operation)).rejects.toMatchObject({
    code: "NOT_READY",
  });
});
it("withholds credential at exact expiry even if retrieval began in time", async () => {
  const f = await fixture();
  const original = await f.provider.retrieve();
  f.provider.retrieve.mockImplementation(async () => {
    f.setTime(f.record.intent.preparation.capacityExpiresAt);
    return original;
  });
  await expect(f.handoff.retrieve(refs.operation)).rejects.toMatchObject({ code: "NOT_READY" });
});
