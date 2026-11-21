import { expect, it } from "vitest";
import {
  createAsapCapacityClockService,
  prepareAsapCapacityCommitment,
  sealAsapCapacityCommitment,
  finishAsapCapacityCommitment,
  type AsapCapacityClockOptions,
  type AsapCapacityCommitment,
} from "../index.js";
const ref = (n: number) => "01900000-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
function input() {
  return {
    allocationReference: ref(1),
    guestSessionReference: ref(2),
    cartReference: ref(3),
    quoteReference: ref(4),
    submissionReference: ref(5),
    orderReference: ref(6),
    orderBatchReference: ref(7),
    fulfillmentReference: ref(8),
    paymentOperationReference: ref(9),
    slot: {
      brandReference: ref(10),
      storeReference: ref(11),
      slotReference: ref(12),
      fulfillmentType: "Pickup",
      configVersion: 1,
      startsAt: at,
      endsAt: "2026-09-10T12:30:00.000Z",
    },
    cartVersion: 1,
    units: 2,
    unitsRuleVersion: 1,
    unitsInputDigest: "sha256:" + "a".repeat(64),
    intentDigest: "sha256:" + "b".repeat(64),
    preparedAt: at,
    preparationValidUntil: "2026-09-10T12:05:00.000Z",
  };
}
function current() {
  return { slot: input().slot, capacityLimit: 5, occupiedUnits: 3, observedAt: at };
}
function prepared() {
  return prepareAsapCapacityCommitment(input(), current());
}

function setup() {
  const record = prepared();
  let saved: AsapCapacityCommitment | null = record;
  let now = at,
    allowed = true,
    version = 1,
    writes = 0,
    orderingReads = 0;
  const acknowledgement = (r: AsapCapacityCommitment) => ({
    allocationReference: r.allocationReference,
    guestSessionReference: r.guestSessionReference,
    cartReference: r.cartReference,
    quoteReference: r.quoteReference,
    submissionReference: r.submissionReference,
    orderReference: r.orderReference,
    orderBatchReference: r.orderBatchReference,
    fulfillmentReference: r.fulfillmentReference,
    paymentOperationReference: r.paymentOperationReference,
    brandReference: r.slot.brandReference,
    storeReference: r.slot.storeReference,
    cartVersion: r.cartVersion,
    intentDigest: r.intentDigest,
    acknowledgedAt: now,
  });
  const options: AsapCapacityClockOptions = {
    scope: {
      brandReference: record.slot.brandReference,
      storeReference: record.slot.storeReference,
    },
    now: () => now,
    authorization: {
      authorize: async (request) =>
        allowed
          ? {
              guestSessionReference: record.guestSessionReference,
              ...options.scope,
              identityVersion: version,
              observedAt: request.observedAt,
              validUntil: "2026-09-10T14:00:00.000Z",
            }
          : null,
    },
    current: {
      resolve: async () => {
        throw new Error("must not acquire capacity");
      },
    },
    repository: {
      loadSubmission: async () => saved,
      append: async ({ record }) => {
        writes++;
        saved = record;
        return { status: "Created", record };
      },
    },
    audit: { prepare: async () => ({}) },
    ordering: {
      resolve: async ({ record }) => {
        orderingReads++;
        return acknowledgement(record);
      },
    },
  };
  return {
    record,
    options,
    acknowledgement,
    service: () => createAsapCapacityClockService(options),
    setTime: (v: string) => {
      now = v;
    },
    setSaved: (v: AsapCapacityCommitment | null) => {
      saved = v;
    },
    revoke: () => {
      allowed = false;
    },
    rotate: () => {
      version++;
    },
    counts: () => ({ writes, orderingReads }),
  };
}
it("seals after positive Order acknowledgement and recovers the original clock without renewal", async () => {
  const f = setup();
  const result = await f.service().seal(f.record);
  expect(result.record.paymentRequestedAt).toBe(at);
  expect(result.record.capacityExpiresAt).toBe("2026-09-10T12:30:00.000Z");
  f.setTime("2026-09-10T12:40:00.000Z");
  expect((await f.service().seal(f.record)).record).toEqual(result.record);
  expect(f.counts()).toEqual({ writes: 1, orderingReads: 1 });
});
it("cannot create a missing preparation", async () => {
  const f = setup();
  f.setSaved(null);
  await expect(f.service().seal(f.record)).rejects.toThrow();
  expect(f.counts()).toEqual({ writes: 0, orderingReads: 0 });
});
it("rejects unlinked or mismatched Order acknowledgement without writing", async () => {
  for (const acknowledgement of [null, { bad: true }]) {
    const f = setup();
    f.options.ordering.resolve = async () => acknowledgement;
    await expect(f.service().seal(f.record)).rejects.toThrow();
    expect(f.counts().writes).toBe(0);
  }
  const f = setup();
  f.options.ordering.resolve = async () => ({
    ...f.acknowledgement(f.record),
    orderReference: ref(99),
  });
  await expect(f.service().seal(f.record)).rejects.toThrow();
  expect(f.counts().writes).toBe(0);
});
it("does not seal if Audit wait reaches original preparation expiry", async () => {
  const f = setup();
  f.options.audit.prepare = async () => {
    f.setTime(f.record.preparationValidUntil);
    return {};
  };
  await expect(f.service().seal(f.record)).rejects.toThrow();
  expect(f.counts().writes).toBe(0);
});
it.each(["revoke", "rotate"] as const)(
  "rechecks %s across the Order acknowledgement wait",
  async (method) => {
    const f = setup();
    f.options.ordering.resolve = async () => {
      f[method]();
      return f.acknowledgement(f.record);
    };
    await expect(f.service().seal(f.record)).rejects.toThrow();
    expect(f.counts().writes).toBe(0);
  },
);
it("recovers a positively persisted seal after an unknown append", async () => {
  const f = setup();
  f.options.repository.append = async ({ record }) => {
    f.setSaved(record);
    throw new Error("lost ack");
  };
  expect((await f.service().seal(f.record)).status).toBe("Existing");
});
it("does not claim success for an unknown append with no sealed history", async () => {
  const f = setup();
  f.options.repository.append = async () => {
    throw new Error("not persisted");
  };
  await expect(f.service().seal(f.record)).rejects.toThrow();
});
it("recovers a concurrent winner's earlier clock instead of overwriting it", async () => {
  const f = setup();
  const winner = sealAsapCapacityCommitment(f.record, f.acknowledgement(f.record), at, at);
  f.setTime("2026-09-10T12:00:01.000Z");
  f.options.audit.prepare = async () => {
    f.setSaved(winner);
    return {};
  };
  expect((await f.service().seal(f.record)).record).toEqual(winner);
  expect(f.counts().writes).toBe(0);
});
it("rejects an unsealed released preparation but recovers sealed terminal history", async () => {
  const f = setup();
  f.setSaved(finishAsapCapacityCommitment(f.record, "Released", at));
  await expect(f.service().seal(f.record)).rejects.toThrow();
  const sealed = sealAsapCapacityCommitment(f.record, f.acknowledgement(f.record), at, at);
  const released = finishAsapCapacityCommitment(sealed, "Released", at);
  f.setSaved(released);
  expect((await f.service().seal(f.record)).record).toEqual(released);
});
it("does not expose a committed seal if Identity is revoked during append", async () => {
  const f = setup();
  f.options.repository.append = async ({ record }) => {
    f.setSaved(record);
    f.revoke();
    return { status: "Created", record };
  };
  await expect(f.service().seal(f.record)).rejects.toThrow();
});
it("rejects a clock moving backward during acknowledgement", async () => {
  const f = setup();
  f.options.ordering.resolve = async () => {
    const ack = f.acknowledgement(f.record);
    f.setTime("2026-09-10T11:59:59.000Z");
    return ack;
  };
  await expect(f.service().seal(f.record)).rejects.toThrow();
  expect(f.counts().writes).toBe(0);
});
