import { expect, it } from "vitest";
import { createCustomerAdditionalDiningPreparation } from "./customer-additional-dining-preparation.js";
import { submissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
function setup() {
  const f = submissionFixture();
  let next = 400,
    orderAllocations = 0;
  const current = {
    brandReference: id(2),
    storeReference: id(3),
    diningSessionReference: id(4),
    orderReference: id(300),
    orderVersion: 3,
  };
  const options = {
    preparation: {
      ...f.options,
      submissions: { loadSubmission: f.loadSubmission },
      references: {
        generate: (purpose: string) => {
          if (purpose === "Order") orderAllocations++;
          return id(next++);
        },
      },
    },
    currentOrder: { resolve: async () => current as typeof current | null },
  };
  const input = { ...f.submissionInput, orderReference: id(300), expectedOrderVersion: 3 };
  return {
    ...f,
    options,
    input,
    current,
    allocations: () => orderAllocations,
    service: () => createCustomerAdditionalDiningPreparation(options),
  };
}
it("prepares a new commitment for the existing Order without allocating another Order", async () => {
  const f = setup(),
    result = await f.service().prepareForOrdering(f.input);
  expect(result.record.orderReference).toBe(id(300));
  expect(result.expectedOrderVersion).toBe(3);
  expect(f.allocations()).toBe(0);
  expect((await f.service().prepareForOrdering(f.input)).record).toEqual(result.record);
  expect(f.writes()).toBe(1);
});
it.each(["orderReference", "storeReference", "diningSessionReference"] as const)(
  "rejects foreign %s before persistence",
  async (field) => {
    const f = setup();
    f.current[field] = id(999);
    await expect(f.service().prepareForOrdering(f.input)).rejects.toBeDefined();
    expect(f.writes()).toBe(0);
  },
);
it("rejects stale expected Order version before persistence", async () => {
  const f = setup();
  f.current.orderVersion = 4;
  await expect(f.service().prepareForOrdering(f.input)).rejects.toBeDefined();
  expect(f.writes()).toBe(0);
});
it("rejects unavailable current eligibility", async () => {
  const f = setup();
  f.options.currentOrder.resolve = async () => null;
  await expect(f.service().prepareForOrdering(f.input)).rejects.toBeDefined();
  expect(f.writes()).toBe(0);
});
it("reauthorizes existing preparation after identity revocation", async () => {
  const f = setup();
  await f.service().prepareForOrdering(f.input);
  f.revoke();
  await expect(f.service().prepareForOrdering(f.input)).rejects.toBeDefined();
  expect(f.writes()).toBe(1);
});

it("rejects an ordinary bound participant before querying Order eligibility", async () => {
  const f = setup();
  const read = f.options.preparation.dining.current.readCurrent;
  let orderReads = 0;
  f.options.currentOrder.resolve = async () => {
    orderReads++;
    return f.current;
  };
  f.options.preparation.dining.current.readCurrent = async (request) => {
    const result = await read(request);
    return result === null
      ? null
      : { ...result, session: { ...result.session, hostParticipantReference: null } };
  };
  await expect(f.service().prepareForOrdering(f.input)).rejects.toBeDefined();
  expect(orderReads).toBe(0);
  expect(f.writes()).toBe(0);
});
