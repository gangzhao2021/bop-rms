import { expect, it, vi } from "vitest";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { createCustomerAdditionalDiningHistoryAuthorization } from "./customer-additional-dining-history-authorization.js";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), dining: vi.fn(), load: vi.fn() }));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresGuestSessionEntryStore: mocks.identity,
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningGuestBindingStore: mocks.dining,
  createPostgresDiningCheckoutCommitmentStore: () => ({ loadSubmission: mocks.load }),
}));
async function fixture() {
  vi.resetAllMocks();
  const f = orderSubmissionFixture();
  const r = (await f.orderService().create(f.orderInput)).record;
  const p = f.options.preparation;
  mocks.identity.mockReturnValue(p.session.store);
  mocks.dining.mockReturnValue(p.dining.current);
  mocks.load.mockResolvedValue(await p.submissions.loadSubmission(r.submissionReference));
  const authorize = createCustomerAdditionalDiningHistoryAuthorization(
    {
      scope: { ...p.scope, tenantReference: p.scope.brandReference },
      identity: () => p,
    },
    f.orderInput,
  );
  const tx = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
  return { f, authorize, tx, binding: { ...p.scope, submissionReference: r.submissionReference } };
}
it("authorizes current real Guest identity and matching commitment before history access", async () => {
  const f = await fixture();
  expect(await f.authorize(f.tx, f.binding)).toBe(true);
  expect(await f.authorize(f.tx, f.binding)).toBe(true);
});
it("rejects wrong current credentials before reading commitment history", async () => {
  const f = await fixture();
  f.f.revoke();
  expect(await f.authorize(f.tx, f.binding)).toBe(false);
  expect(mocks.load).not.toHaveBeenCalled();
});
it("rejects another Store before constructing identity stores", async () => {
  const f = await fixture();
  expect(await f.authorize(f.tx, { ...f.binding, storeReference: id(999) })).toBe(false);
  expect(mocks.identity).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
});
