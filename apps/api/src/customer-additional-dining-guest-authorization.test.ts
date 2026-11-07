import { expect, it, vi } from "vitest";
import { parseOrderingReference } from "@rms/ordering";
import { fixture, id } from "../test-support/dining-order-submission-fixture.js";
import { createCustomerAdditionalDiningGuestAuthorization } from "./customer-additional-dining-guest-authorization.js";
function setup() {
  const f = fixture();
  const target = {
    brandReference: parseOrderingReference(id(2)),
    storeReference: parseOrderingReference(id(3)),
    guestSessionReference: parseOrderingReference(id(9)),
    diningSessionReference: parseOrderingReference(id(4)),
    batch: { submittedByActorReference: parseOrderingReference(id(9)) },
  };
  return { f, target, transaction: { query: vi.fn() } };
}
it("authorizes actual Guest credentials and CSRF for matching additional submission scope", async () => {
  const { f, target, transaction } = setup();
  const authorize = createCustomerAdditionalDiningGuestAuthorization(f.options, f.input);
  expect(await authorize(transaction, target)).toBe(true);
  expect(await authorize(transaction, target)).toBe(true);
});
it("rejects invalid CSRF through the existing Identity service", async () => {
  const { f, target, transaction } = setup();
  const authorize = createCustomerAdditionalDiningGuestAuthorization(f.options, {
    ...f.input,
    csrfCredential: f.credentials.generateCredential("Csrf"),
  });
  expect(await authorize(transaction, target)).toBe(false);
});
it("rechecks revocation on subsequent owner authorization", async () => {
  const { f, target, transaction } = setup();
  const authorize = createCustomerAdditionalDiningGuestAuthorization(f.options, f.input);
  expect(await authorize(transaction, target)).toBe(true);
  f.revoke();
  expect(await authorize(transaction, target)).toBe(false);
});
it.each([
  "brandReference",
  "storeReference",
  "guestSessionReference",
  "diningSessionReference",
] as const)("rejects mismatched %s", async (field) => {
  const { f, target, transaction } = setup();
  const authorize = createCustomerAdditionalDiningGuestAuthorization(f.options, f.input);
  expect(await authorize(transaction, { ...target, [field]: parseOrderingReference(id(99)) })).toBe(
    false,
  );
});

it("rejects a different recorded submitter despite valid Guest credentials", async () => {
  const { f, target, transaction } = setup();
  const authorize = createCustomerAdditionalDiningGuestAuthorization(f.options, f.input);
  expect(
    await authorize(transaction, {
      ...target,
      batch: { submittedByActorReference: parseOrderingReference(id(99)) },
    }),
  ).toBe(false);
});
it("rechecks the recorded submitter on every authorization, including replay", async () => {
  const { f, target, transaction } = setup();
  const authorize = createCustomerAdditionalDiningGuestAuthorization(f.options, f.input);
  expect(await authorize(transaction, target)).toBe(true);
  expect(
    await authorize(transaction, {
      ...target,
      batch: { submittedByActorReference: parseOrderingReference(id(99)) },
    }),
  ).toBe(false);
});
