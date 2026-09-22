import { describe, expect, it } from "vitest";
import {
  createAsapCapacityService,
  sealAsapCapacityCommitment,
  finishAsapCapacityCommitment,
  prepareAsapCapacityCommitment,
  type AsapCapacityServiceOptions,
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
  let observedAt = at;
  let saved: AsapCapacityCommitment | null = null;
  let allowed = true;
  let identityVersion = 1;
  let writes = 0;
  let auditCalls = 0;
  let sourceCalls = 0;
  const record = prepared();
  const options: AsapCapacityServiceOptions = {
    scope: {
      brandReference: record.slot.brandReference,
      storeReference: record.slot.storeReference,
    },
    now: () => observedAt,
    authorization: {
      authorize: async (request) =>
        allowed
          ? {
              guestSessionReference: record.guestSessionReference,
              brandReference: record.slot.brandReference,
              storeReference: record.slot.storeReference,
              identityVersion,
              observedAt: request.observedAt,
              validUntil: "2026-09-10T14:00:00.000Z",
            }
          : null,
    },
    current: {
      resolve: async (_record, time) => {
        sourceCalls++;
        return { ...current(), observedAt: time };
      },
    },
    repository: {
      loadSubmission: async () => saved,
      append: async (request) => {
        writes++;
        saved = request.record;
        return { status: "Created", record: saved };
      },
    },
    audit: {
      prepare: async () => {
        auditCalls++;
        return {};
      },
    },
  };
  return {
    options,
    record,
    service: createAsapCapacityService(options),
    setTime: (time: string) => {
      observedAt = time;
    },
    revoke: () => {
      allowed = false;
    },
    changeVersion: () => {
      identityVersion++;
    },
    setSaved: (value: AsapCapacityCommitment) => {
      saved = value;
    },
    counts: () => ({ writes, auditCalls, sourceCalls }),
  };
}
describe("ASAP application current authority", () => {
  it("creates once and recovers exact original history without reacquiring", async () => {
    const f = setup();
    expect((await f.service.prepare(f.record)).status).toBe("Created");
    expect((await f.service.prepare(f.record)).status).toBe("Existing");
    expect(f.counts()).toEqual({ writes: 1, auditCalls: 1, sourceCalls: 1 });
  });
  it("allows a current observation after the original preparation instant", async () => {
    const f = setup();
    f.setTime("2026-09-10T12:00:01.000Z");
    expect((await f.service.prepareForOrdering(f.record)).record.preparedAt).toBe(at);
  });
  it("rejects revoked identity before reading or acquiring", async () => {
    const f = setup();
    f.revoke();
    await expect(f.service.prepare(f.record)).rejects.toThrow();
    expect(f.counts()).toEqual({ writes: 0, auditCalls: 0, sourceCalls: 0 });
  });
  it("recovers expired history but does not authorize another Order", async () => {
    const f = setup();
    await f.service.prepare(f.record);
    f.setTime(f.record.preparationValidUntil);
    expect((await f.service.prepare(f.record)).status).toBe("Existing");
    await expect(f.service.prepareForOrdering(f.record)).rejects.toMatchObject({
      code: "ASAP_CAPACITY_EXPIRED",
    });
  });
  it("rechecks identity after current capacity resolution", async () => {
    const f = setup();
    f.options.current.resolve = async (_record, time) => {
      f.revoke();
      return { ...current(), observedAt: time };
    };
    await expect(f.service.prepare(f.record)).rejects.toThrow();
    expect(f.counts().writes).toBe(0);
  });
  it("rechecks identity version after Audit preparation", async () => {
    const f = setup();
    f.options.audit.prepare = async () => {
      f.changeVersion();
      return {};
    };
    await expect(f.service.prepare(f.record)).rejects.toThrow();
    expect(f.counts().writes).toBe(0);
  });
  it("does not write after a deadline expires during Audit preparation", async () => {
    const f = setup();
    f.options.audit.prepare = async () => {
      f.setTime(f.record.preparationValidUntil);
      return {};
    };
    await expect(f.service.prepare(f.record)).rejects.toMatchObject({
      code: "ASAP_CAPACITY_EXPIRED",
    });
    expect(f.counts().writes).toBe(0);
  });
  it("recovers positive original history after an unknown commit result", async () => {
    const f = setup();
    f.options.repository.append = async (request) => {
      f.setSaved(request.record);
      throw new Error("synthetic");
    };
    expect((await f.service.prepare(f.record)).status).toBe("Existing");
  });
  it("does not infer success when an unknown result has no stored history", async () => {
    const f = setup();
    f.options.repository.append = async () => {
      throw new Error("synthetic");
    };
    await expect(f.service.prepare(f.record)).rejects.toMatchObject({
      code: "ASAP_CAPACITY_UNAVAILABLE",
    });
  });
  it("rejects mismatched history and inaccurate observation time", async () => {
    const f = setup();
    f.setSaved({ ...f.record, cartVersion: 2 });
    await expect(f.service.prepare(f.record)).rejects.toMatchObject({
      code: "ASAP_CAPACITY_CONFLICT",
    });
    const g = setup();
    g.options.current.resolve = async () => ({
      ...current(),
      observedAt: "2026-09-10T11:59:59.000Z",
    });
    await expect(g.service.prepare(g.record)).rejects.toThrow();
    expect(g.counts().writes).toBe(0);
  });
  it("does not expose committed history after authorization is revoked during append", async () => {
    const f = setup();
    f.options.repository.append = async (request) => {
      f.setSaved(request.record);
      f.revoke();
      return { status: "Created", record: request.record };
    };
    await expect(f.service.prepare(f.record)).rejects.toThrow();
  });
});

function sealedRecord(record: AsapCapacityCommitment) {
  const {
    slot,
    allocationReference,
    guestSessionReference,
    cartReference,
    quoteReference,
    submissionReference,
    orderReference,
    orderBatchReference,
    fulfillmentReference,
    paymentOperationReference,
    cartVersion,
    intentDigest,
  } = record;
  return sealAsapCapacityCommitment(
    record,
    {
      allocationReference,
      guestSessionReference,
      cartReference,
      quoteReference,
      submissionReference,
      orderReference,
      orderBatchReference,
      fulfillmentReference,
      paymentOperationReference,
      brandReference: slot.brandReference,
      storeReference: slot.storeReference,
      cartVersion,
      intentDigest,
      acknowledgedAt: at,
    },
    at,
    at,
  );
}
it("permits current sealed capacity after Quote preparation expiry, with no acquisition", async () => {
  const f = setup();
  const sealed = sealedRecord(f.record);
  f.setSaved(sealed);
  f.setTime("2026-09-10T12:06:00.000Z");
  expect((await f.service.authorizePayment(f.record)).record).toEqual(sealed);
  expect(f.counts()).toEqual({ writes: 0, auditCalls: 0, sourceCalls: 0 });
  f.setTime(sealed.capacityExpiresAt as string);
  await expect(f.service.authorizePayment(f.record)).rejects.toMatchObject({
    code: "ASAP_CAPACITY_EXPIRED",
  });
});
it("never creates missing or unsealed capacity while authorizing Payment", async () => {
  const f = setup();
  await expect(f.service.authorizePayment(f.record)).rejects.toThrow();
  f.setSaved(f.record);
  await expect(f.service.authorizePayment(f.record)).rejects.toThrow();
  expect(f.counts().writes).toBe(0);
});
it("rejects a terminal capacity transition during current Payment authorization", async () => {
  const f = setup(),
    sealed = sealedRecord(setup().record);
  f.setSaved(sealed);
  const authorize = f.options.authorization.authorize;
  f.options.authorization.authorize = async (request) => {
    if (request.action === "UseAsapCapacityForPayment")
      f.setSaved(finishAsapCapacityCommitment(sealed, "Released", at));
    return authorize(request);
  };
  await expect(f.service.authorizePayment(f.record)).rejects.toMatchObject({
    code: "ASAP_CAPACITY_EXPIRED",
  });
});
it("rejects revoked current Payment authority despite recoverable original clock", async () => {
  const f = setup();
  f.setSaved(sealedRecord(f.record));
  f.revoke();
  await expect(f.service.authorizePayment(f.record)).rejects.toThrow();
});
