import { parseDiningCheckoutCommitment } from "@rms/dining";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";
import {
  fixture,
  submissionFixture,
  orderSubmissionFixture,
  id,
  at,
} from "../test-support/dining-order-submission-fixture.js";

it("uses Identity credentials and CSRF to derive the bound Guest and Participant", async () => {
  const f = fixture(),
    result = await f.service().prepare(f.input);
  expect(result.record.guestSessionReference).toBe(id(9));
  expect(result.record.participantReference).toBe(id(8));
  expect(result.record.tableReference).toBe(id(6));
  expect(f.writes()).toBe(1);
});
it("rejects invalid CSRF before preparing a commitment", async () => {
  const f = fixture();
  await expect(
    f.service().prepare({ ...f.input, csrfCredential: f.credentials.generateCredential("Csrf") }),
  ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  expect(f.writes()).toBe(0);
});
it("rejects caller-supplied Guest identity", async () => {
  const f = fixture();
  await expect(
    f
      .service()
      .prepare({ ...f.input, intent: { ...f.input.intent, guestSessionReference: id(99) } }),
  ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  expect(f.writes()).toBe(0);
});
it("reauthenticates a retry instead of trusting prior persistence", async () => {
  const f = fixture();
  await f.service().prepare(f.input);
  f.revoke();
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  expect(f.writes()).toBe(1);
});
it("rejects missing current QR mapping even with a valid credential", async () => {
  const f = fixture();
  f.options.contexts.resolve = async () => null;
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  expect(f.writes()).toBe(0);
});
it("rejects revocation during an owner audit wait", async () => {
  const f = fixture(),
    audit = f.options.dining.audit.create;
  f.options.dining.audit.create = async (request) => {
    f.revoke();
    return audit(request);
  };
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.writes()).toBe(0);
});

it("produces the exact Ordering link from current authenticated owner preparation", async () => {
  const f = fixture();
  const result = await f.service().prepareForOrdering(f.input);
  expect(result.link).toMatchObject({
    owner: "Dining",
    commitmentReference: f.input.intent.commitmentReference,
    commitmentVersion: 1,
    ownerContextReference: id(4),
    guestSessionReference: id(9),
    submissionReference: f.input.intent.submissionReference,
    orderReference: f.input.intent.orderReference,
    orderBatchReference: f.input.intent.orderBatchReference,
    paymentOperationReference: f.input.intent.paymentOperationReference,
    ownerIntentDigest: "sha256:" + result.record.intentHash,
    ownerSnapshotDigest:
      "sha256:" +
      createHash("sha256")
        .update("DiningCheckoutPrepared:v1:" + JSON.stringify(result.record))
        .digest("hex"),
    preparedAt: at,
    validUntil: f.input.intent.sourceValidUntil,
  });
  expect((await f.service().prepareForOrdering(f.input)).link).toEqual(result.link);
  expect(f.writes()).toBe(1);
});
it("does not issue an Ordering link from expired durable history", async () => {
  const f = fixture();
  await f.service().prepare(f.input);
  f.setTime(f.input.intent.sourceValidUntil);
  await expect(f.service().prepareForOrdering(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.writes()).toBe(1);
});
it("does not issue an Ordering link after current Session closure", async () => {
  const f = fixture();
  await f.service().prepare(f.input);
  const read = f.options.dining.current.readCurrent;
  f.options.dining.current.readCurrent = async (request) => {
    const snapshot = await read(request);
    if (snapshot === null) throw new Error("missing fixture");
    return { ...snapshot, session: { ...snapshot.session, phase: "Closing", version: 6 } };
  };
  await expect(f.service().prepareForOrdering(f.input)).rejects.toBeDefined();
  expect(f.writes()).toBe(1);
});
it("rejects caller-supplied link evidence and revoked authority on the Ordering path", async () => {
  const f = fixture();
  await expect(
    f.service().prepareForOrdering({
      ...f.input,
      intent: { ...f.input.intent, ownerSnapshotDigest: "sha256:" + "a".repeat(64) },
    }),
  ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  await f.service().prepareForOrdering(f.input);
  f.revoke();
  await expect(f.service().prepareForOrdering(f.input)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  expect(f.writes()).toBe(1);
});

it("persists first server IDs and recovers them without generating replacements", async () => {
  const f = submissionFixture();
  const first = await f.submission.prepare(f.submissionInput);
  const replay = await f.submission.prepare(f.submissionInput);
  expect(replay).toEqual({ status: "Existing", record: first.record });
  expect(f.generated()).toBe(4);
  expect(f.writes()).toBe(1);
});
it("recovers one winning server ID set after concurrent unique-submission contention", async () => {
  const f = submissionFixture();
  const pair = await Promise.all([
    f.submission.prepare(f.submissionInput),
    f.submission.prepare(f.submissionInput),
  ]);
  expect(pair.map((r) => r.status).sort()).toEqual(["Created", "Existing"]);
  expect(pair[0]?.record).toEqual(pair[1]?.record);
  expect(f.writes()).toBe(1);
});
it("positively recovers a preparation whose commit acknowledgement was lost", async () => {
  const f = submissionFixture();
  const append = f.options.dining.repository.append;
  f.options.dining.repository.append = async (request) => {
    await append(request);
    throw new Error("synthetic response loss");
  };
  const recovered = await f.submission.prepare(f.submissionInput);
  expect(recovered.status).toBe("Existing");
  expect(f.writes()).toBe(1);
  expect(f.generated()).toBe(4);
});
it("does not mistake an absent failed preparation for a completed operation", async () => {
  const f = submissionFixture();
  f.options.dining.repository.append = async () => {
    throw new Error("synthetic rollback");
  };
  await expect(f.submission.prepare(f.submissionInput)).rejects.toBeDefined();
  expect(f.writes()).toBe(0);
  expect(f.generated()).toBe(4);
});
it("refuses changed intent or renewed deadline on a recovered submission", async () => {
  const f = submissionFixture();
  await f.submission.prepare(f.submissionInput);
  for (const patch of [
    { cartVersion: 4 },
    { quoteReference: id(999) },
    { sourceValidUntil: "2026-09-10T12:06:00.000Z" },
  ])
    await expect(
      f.submission.prepare({
        ...f.submissionInput,
        intent: { ...f.submissionInput.intent, ...patch },
      }),
    ).rejects.toMatchObject({ code: "DINING_CHECKOUT_INTENT_CONFLICT" });
  expect(f.generated()).toBe(4);
  expect(f.writes()).toBe(1);
});
it("rejects caller operation IDs and revoked credentials before allocating server IDs", async () => {
  const f = submissionFixture();
  await expect(
    f.submission.prepare({
      ...f.submissionInput,
      intent: { ...f.submissionInput.intent, orderReference: id(999) },
    }),
  ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  f.revoke();
  await expect(f.submission.prepare(f.submissionInput)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  expect(f.generated()).toBe(0);
  expect(f.writes()).toBe(0);
});

it("connects first server ID persistence to the current Ordering receipt producer", async () => {
  const f = submissionFixture();
  const first = await f.submission.prepareForOrdering(f.submissionInput);
  const retry = await f.submission.prepareForOrdering(f.submissionInput);
  expect(first.link.orderReference).toBe(first.record.orderReference);
  expect(first.link.paymentOperationReference).toBe(first.record.paymentOperationReference);
  expect(retry.link).toEqual(first.link);
  expect(f.generated()).toBe(4);
  expect(f.writes()).toBe(1);
});
it("recovers expired submission IDs as history but never issues a new Ordering receipt", async () => {
  const f = submissionFixture();
  await f.submission.prepare(f.submissionInput);
  f.setTime(f.submissionInput.intent.sourceValidUntil);
  await expect(f.submission.prepareForOrdering(f.submissionInput)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.generated()).toBe(4);
  expect(f.writes()).toBe(1);
});

it("composes actual Checkout and Order services with the current Dining receipt and server IDs", async () => {
  const f = orderSubmissionFixture();
  const result = await f.orderService().create(f.orderInput);
  expect(result.status).toBe("Created");
  expect(result.record.order.orderType).toBe("DineIn");
  expect(result.record.order.orderReference).toBe(f.savedLink()?.orderReference);
  expect(result.record.order.batches[0]?.orderBatchReference).toBe(
    f.savedLink()?.orderBatchReference,
  );
  expect(f.catalogCalls()).toBe(1);
  expect(f.orderWrites()).toBe(1);
  expect(f.writes()).toBe(1);
});
it("recovers a committed Order after Quote expiry without rerunning current Checkout", async () => {
  const f = orderSubmissionFixture();
  const first = await f.orderService().create(f.orderInput);
  const reads = f.sourceReads();
  f.setTime("2026-09-10T12:06:00.000Z");
  const replay = await f.orderService().create(f.orderInput);
  expect(replay).toEqual({ status: "AlreadyCreated", record: first.record });
  expect(f.sourceReads()).toBe(reads);
  expect(f.catalogCalls()).toBe(1);
  expect(f.orderWrites()).toBe(1);
});
it("recovers the original linked Order after a lost commit acknowledgement", async () => {
  const f = orderSubmissionFixture();
  f.loseAck();
  await expect(f.orderService().create(f.orderInput)).rejects.toBeDefined();
  const recovered = await f.orderService().create(f.orderInput);
  expect(recovered.status).toBe("AlreadyCreated");
  expect(recovered.record.order.orderReference).toBe(f.savedLink()?.orderReference);
  expect(f.orderWrites()).toBe(1);
});
it("denies Catalog rejection before Order creation while retaining the prepared operation", async () => {
  const f = orderSubmissionFixture();
  f.options.checkout.catalog.validateSelection = async () => ({
    status: "Rejected",
    reason: "SELLABLE_UNAVAILABLE",
  });
  await expect(f.orderService().create(f.orderInput)).rejects.toMatchObject({
    code: "CHECKOUT_ITEM_UNAVAILABLE",
  });
  expect(f.orderWrites()).toBe(0);
  expect(f.writes()).toBe(1);
});
it("rechecks Dining after Catalog waits and refuses a closed Session", async () => {
  const f = orderSubmissionFixture();
  const validate = f.options.checkout.catalog.validateSelection;
  const read = f.options.preparation.dining.current.readCurrent;
  f.options.checkout.catalog.validateSelection = async (request) => {
    const result = await validate(request);
    f.options.preparation.dining.current.readCurrent = async (query) => {
      const snapshot = await read(query);
      if (snapshot === null) throw new Error("missing fixture");
      return { ...snapshot, session: { ...snapshot.session, phase: "Closing", version: 6 } };
    };
    return result;
  };
  await expect(f.orderService().create(f.orderInput)).rejects.toBeDefined();
  expect(f.orderWrites()).toBe(0);
});

it("retains the original Prepared link digest when owner history is later sealed or expired", async () => {
  const f = fixture();
  const original = await f.service().prepareForOrdering(f.input);
  for (const state of ["PaymentPending", "Expired"])
    expect(
      diningOrderCapacityLinkFromHistory({
        ...original.record,
        state,
        orderingLinkedAt: at,
        paymentRequestedAt: at,
        capacityExpiresAt: "2026-09-10T12:30:00.000Z",
      }),
    ).toEqual(original.link);
});
it("requires current credentials even when the original Order is recoverable", async () => {
  const f = orderSubmissionFixture();
  await f.orderService().create(f.orderInput);
  f.revoke();
  await expect(f.orderService().create(f.orderInput)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  expect(f.orderWrites()).toBe(1);
});
it("does not accept caller deadlines or permanent Order IDs at the submission boundary", async () => {
  const f = orderSubmissionFixture();
  for (const patch of [
    { sourceValidUntil: "2026-09-11T12:00:00.000Z" },
    { orderReference: id(999) },
  ])
    await expect(f.orderService().create({ ...f.orderInput, ...patch })).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
  expect(f.writes()).toBe(0);
  expect(f.orderWrites()).toBe(0);
});

it("does not start submission when Payment clock dependencies are unconfigured", async () => {
  const f = orderSubmissionFixture();
  await expect(f.orderService().preparePaymentClock(f.orderInput)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  expect(f.orderWrites()).toBe(0);
  expect(f.writes()).toBe(0);
});

it("checks current payment authority with real Identity/CSRF and an original sealed owner record", async () => {
  const f = fixture(),
    prepared = (await f.service().prepare(f.input)).record;
  const sealed = parseDiningCheckoutCommitment({
    ...prepared,
    state: "PaymentPending",
    orderingLinkedAt: at,
    paymentRequestedAt: at,
    capacityExpiresAt: "2026-09-10T12:30:00.000Z",
  });
  f.options.dining.repository.load = async () => sealed;
  f.setTime("2026-09-10T12:06:00.000Z");
  expect((await f.service().authorizePayment(f.input)).record).toEqual(sealed);
  await expect(
    f
      .service()
      .authorizePayment({ ...f.input, csrfCredential: f.credentials.generateCredential("Csrf") }),
  ).rejects.toThrow();
  f.revoke();
  await expect(f.service().authorizePayment(f.input)).rejects.toThrow();
  expect(f.writes()).toBe(1);
});
it("does not create a missing owner record through current payment authorization", async () => {
  const f = fixture();
  await expect(f.service().authorizePayment(f.input)).rejects.toThrow();
  expect(f.writes()).toBe(0);
});
