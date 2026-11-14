import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { expect, it } from "vitest";
import {
  parseOrderCapacityLink,
  encodeAdditionalDiningBatchSnapshot,
  parseAdditionalDiningBatchSnapshot,
  parseOrderingReference,
} from "@rms/ordering";
import { parsePaymentInstant } from "@rms/payment";
import { orderSubmissionFixture, id, at } from "../test-support/dining-order-submission-fixture.js";
import {
  createCustomerDiningPaymentAuthorization,
  createPersistentAdditionalDiningPaymentAuthorization,
  createCustomerAdditionalDiningPaymentAuthorization,
} from "./customer-dining-payment-authorization.js";

async function fixture() {
  const f = orderSubmissionFixture();
  await f.orderService().create(f.orderInput);
  const link = f.savedLink();
  if (link === null) throw new Error("missing fixture link");
  const options = { preparation: f.options.preparation, ordering: f.options.repository(link) };
  const credentials = {
    sessionCredential: f.orderInput.sessionCredential,
    csrfCredential: f.orderInput.csrfCredential,
  };
  const request = {
    action: "CreatePaymentIntent" as const,
    submissionReference: String(link.submissionReference),
    paymentOperationReference: String(link.paymentOperationReference),
    observedAt: parsePaymentInstant(at),
  };
  return {
    ...f,
    options,
    credentials,
    request,
    port: () => createCustomerDiningPaymentAuthorization(options, credentials),
  };
}
it("resolves current Identity and exact original Dining Order operation", async () => {
  const f = await fixture();
  expect(await f.port().authorize(f.request)).toEqual({
    action: "CreatePaymentIntent",
    guestSessionReference: id(9),
    brandReference: id(2),
    storeReference: id(3),
  });
});
it("denies wrong CSRF before reading Order history", async () => {
  const f = await fixture();
  let reads = 0;
  f.options.ordering.resolveSubmission = async () => {
    reads++;
    return null;
  };
  const port = createCustomerDiningPaymentAuthorization(f.options, {
    ...f.credentials,
    csrfCredential:
      (f.credentials.csrfCredential[0] === "A" ? "B" : "A") + f.credentials.csrfCredential.slice(1),
  });
  expect(await port.authorize(f.request)).toBeNull();
  expect(reads).toBe(0);
});
it("denies missing or mismatched original operation and scope", async () => {
  const f = await fixture();
  expect(await f.port().authorize({ ...f.request, paymentOperationReference: id(999) })).toBeNull();
  const load = f.options.ordering.resolveCapacityLink;
  for (const change of [
    { guestSessionReference: id(999) },
    { storeReference: id(999) },
    { ownerContextReference: id(999) },
  ]) {
    f.options.ordering.resolveCapacityLink = async (ref) =>
      parseOrderCapacityLink({ ...(await load(ref)), ...change });
    expect(await f.port().authorize(f.request)).toBeNull();
  }
  f.options.ordering.resolveCapacityLink = async () => null;
  expect(await f.port().authorize(f.request)).toBeNull();
});
it("reauthorizes after an Order history await and on subsequent calls", async () => {
  const f = await fixture();
  const load = f.options.ordering.resolveSubmission;
  f.options.ordering.resolveSubmission = async (ref) => {
    const record = await load(ref);
    f.revoke();
    return record;
  };
  expect(await f.port().authorize(f.request)).toBeNull();
  const other = await fixture(),
    port = other.port();
  expect(await port.authorize(other.request)).not.toBeNull();
  other.revoke();
  expect(await port.authorize(other.request)).toBeNull();
});
it("does not equate expired preparation with loss of historical access", async () => {
  const f = await fixture();
  f.setTime("2026-09-10T12:06:00.000Z");
  expect(
    await f
      .port()
      .authorize({ ...f.request, observedAt: parsePaymentInstant("2026-09-10T12:06:00.000Z") }),
  ).not.toBeNull();
});
it("denies future time and request-local operation replacement", async () => {
  const f = await fixture(),
    port = f.port();
  expect(
    await port.authorize({
      ...f.request,
      observedAt: parsePaymentInstant("2026-09-10T13:00:00.000Z"),
    }),
  ).toBeNull();
  expect(await port.authorize(f.request)).not.toBeNull();
  expect(await port.authorize({ ...f.request, submissionReference: id(999) })).toBeNull();
});

async function additionalFixture() {
  const f = await fixture();
  const record = await f.options.ordering.resolveSubmission(
    parseOrderingReference(f.request.submissionReference),
  );
  const link = f.savedLink();
  if (!record || !link) throw new Error("missing original synthetic history");
  const batch = {
    ...record.order.batches[0],
    orderBatchReference: parseOrderingReference(id(800)),
    items: record.order.batches[0].items.map((item) => ({
      ...item,
      orderBatchReference: parseOrderingReference(id(800)),
    })),
    submissionReference: parseOrderingReference(id(801)),
  };
  const snapshot = parseAdditionalDiningBatchSnapshot({
    orderReference: record.order.orderReference,
    brandReference: record.order.brandReference,
    storeReference: record.order.storeReference,
    diningSessionReference: record.order.diningSessionReference,
    guestSessionReference: record.guestSessionReference,
    originalOrderCreatedAt: record.createdAt,
    expectedOrderVersion: 1,
    batchSequence: 2,
    snapshotVersion: 1,
    batch,
    items: record.items.map((item) => ({
      ...item,
      orderBatchReference: batch.orderBatchReference,
    })),
  });
  const additionalLink = parseOrderCapacityLink({
    ...link,
    orderBatchReference: batch.orderBatchReference,
    submissionReference: batch.submissionReference,
    paymentOperationReference: id(802),
  });
  const options = {
    preparation: f.options.preparation,
    ordering: {
      resolveSubmission: async () => snapshot,
      resolveCapacityLink: async () => additionalLink,
    },
  };
  const request = {
    ...f.request,
    submissionReference: id(801),
    paymentOperationReference: id(802),
  };
  return {
    ...f,
    options,
    request,
    additionalLink,
    port: () => createCustomerAdditionalDiningPaymentAuthorization(options, f.credentials),
  };
}
it("authorizes the additional Batch's own submission and payment operation", async () => {
  const f = await additionalFixture();
  expect(await f.port().authorize(f.request)).toMatchObject({ guestSessionReference: id(9) });
  expect(await f.port().authorize({ ...f.request, submissionReference: id(999) })).toBeNull();
});
it.each(["orderBatchReference", "quoteReference", "guestSessionReference"])(
  "denies additional payment when saved link %s differs",
  async (field) => {
    const f = await additionalFixture();
    f.options.ordering.resolveCapacityLink = async () =>
      parseOrderCapacityLink({ ...f.additionalLink, [field]: id(999) });
    expect(await f.port().authorize(f.request)).toBeNull();
  },
);
it("reauthorizes after additional history loading", async () => {
  const f = await additionalFixture();
  const load = f.options.ordering.resolveSubmission;
  f.options.ordering.resolveSubmission = async () => {
    const result = await load();
    f.revoke();
    return result;
  };
  expect(await f.port().authorize(f.request)).toBeNull();
});

it.each([false, true])(
  "uses real owner history SQL for additional payment (revoked=%s)",
  async (revoked) => {
    const f = await additionalFixture();
    const snapshot = await f.options.ordering.resolveSubmission();
    const encoded = encodeAdditionalDiningBatchSnapshot(snapshot);
    const calls: string[] = [];
    const transaction: ConsumerTransaction = {
      async query<Row = Record<string, unknown>>(sql: string) {
        calls.push(sql);
        if (sql.startsWith("SELECT a.snapshot_json")) {
          if (revoked) f.revoke();
          return {
            rows: [
              {
                snapshot: encoded,
                batch_sequence: 2,
                version: 2,
                intent_digest: "sha256:" + createHash("sha256").update(encoded).digest("hex"),
                link: f.additionalLink,
              },
            ] as Row[],
            rowCount: 1,
          };
        }
        return { rows: [] as Row[], rowCount: 1 };
      },
    };
    const history = {
      brandReference: f.additionalLink.brandReference,
      storeReference: f.additionalLink.storeReference,
      transactions: {
        run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
      },
      authorize: async (tx: ConsumerTransaction) => tx === transaction,
    };
    const options = { preparation: f.options.preparation, history };
    const port = createPersistentAdditionalDiningPaymentAuthorization(options, f.credentials);
    const result = await port.authorize(f.request);
    if (revoked) expect(result).toBeNull();
    else expect(result).toMatchObject({ guestSessionReference: id(9) });
    expect(calls.some((sql) => sql.startsWith("SELECT a.snapshot_json"))).toBe(true);
    expect(() =>
      createPersistentAdditionalDiningPaymentAuthorization(
        {
          ...options,
          history: { ...history, storeReference: id(999) },
        },
        f.credentials,
      ),
    ).toThrow("scope mismatch");
  },
);
