import { beforeEach, expect, it, vi } from "vitest";
import {
  approvalDerivedReference,
  createMerchantOrdinaryRefundApproval,
  MerchantRefundApprovalError,
  recentEnough,
  refundMfaRecencyMilliseconds,
} from "./merchant-ordinary-refund-approval.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  escalation: vi.fn(),
  subject: vi.fn(),
  reader: vi.fn(),
  source: vi.fn(),
  store: vi.fn(),
  record: vi.fn(),
  cards: vi.fn(),
  party: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("./merchant-ordinary-refund-authority.js", () => ({
  createMerchantOrdinaryRefundAuthority: () => doubles.party,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  createPostgresOrdinaryRefundCurrentEscalationSource: doubles.escalation,
  createPostgresOrdinaryRefundApprovalSubjectSource: doubles.subject,
  createPostgresOrdinaryRefundApprovalReader: doubles.reader,
  createPostgresOrdinaryRefundApprovalSource: doubles.source,
  createPostgresOrdinaryRefundApprovalStore: doubles.store,
  createPostgresCardMachinePaymentStore: doubles.cards,
  ordinaryRefundClaimKind: () => "Ordinary",
}));

const approval = "0190a7c6-1234-7abc-8def-0123456789ab";
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
it("derives stable, distinct UUIDv7 identities per purpose from the approval reference", () => {
  const purposes = ["approval-audit", "approval-operation", "operation:a", "dispatch:a"];
  const derived = purposes.map((purpose) => approvalDerivedReference(approval, purpose));
  for (const value of derived) {
    expect(value).toMatch(uuidV7);
    expect(value.slice(0, 13)).toBe(approval.slice(0, 13));
  }
  expect(new Set(derived).size).toBe(purposes.length);
  expect(approvalDerivedReference(approval, "operation:a")).toBe(derived[2]);
  expect(approvalDerivedReference("0190a7c6-1234-7abc-8def-0123456789ac", "operation:a")).not.toBe(
    derived[2],
  );
});
it("treats a verification as recent for exactly 15 minutes and never from the future", () => {
  const at = "2026-10-12T15:15:00.000Z";
  expect(refundMfaRecencyMilliseconds).toBe(900_000);
  expect(recentEnough("2026-10-12T15:00:00.000Z", at)).toBe(true);
  expect(recentEnough("2026-10-12T14:59:59.999Z", at)).toBe(false);
  expect(recentEnough("2026-10-12T15:15:00.001Z", at)).toBe(false);
  expect(recentEnough(null, at)).toBe(false);
});

const id = (n: number) => "0190a7c6-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrdinaryRefundApproval>[0];
type Authorize = (t: unknown, query: Record<string, unknown>) => Promise<boolean>;
const observedAt = "2026-10-15T12:00:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
beforeEach(() => vi.resetAllMocks());
function setup() {
  const allowed = vi.fn(async () => true),
    during: boolean[] = [];
  let rolledBack: unknown = null;
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn() }).catch((error: unknown) => {
      rolledBack = error;
      throw error;
    }),
  );
  doubles.scope.mockResolvedValue({
    actorReference: id(4),
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    allowed,
  });
  // Each Payment owner read asks its authorize callback (the run's guard) as it runs.
  const asks =
    <T>(result: T) =>
    (owner: { authorize: Authorize }) =>
    async () => {
      during.push(await owner.authorize({}, { ...scope, orderReference: id(6) }));
      return result;
    };
  doubles.escalation.mockImplementation(asks({ observedAt }));
  doubles.subject.mockImplementation(
    asks({
      requesterReference: id(5),
      request: {
        reasonCode: "CUSTOMER_REQUEST",
        payments: [{ paymentAttemptReference: id(8), paymentIntentReference: id(9) }],
      },
    }),
  );
  doubles.reader.mockImplementation(asks(null));
  doubles.source.mockImplementation(
    asks({ approval: { approvedAt: observedAt }, claimVersion: 1 }),
  );
  doubles.store.mockImplementation((owner: { authorize: Authorize }) => ({
    record: async () => {
      during.push(await owner.authorize({}, { ...scope, orderReference: id(6) }));
      // Another Order is refused without a query.
      during.push(await owner.authorize({}, { ...scope, orderReference: id(99) }));
      doubles.record();
    },
  }));
  doubles.cards.mockImplementation((owner: { authorize: Authorize }) => ({
    loadByIntent: async () => {
      during.push(await owner.authorize({}, { orderReference: id(6) }));
      return null;
    },
  }));
  doubles.party.mockImplementation(async (_tx: unknown, query: { actorReference: string }) => ({
    role: query.actorReference === id(5) ? "Manager" : "Owner",
    allowed: true,
    recentMfaAt: observedAt,
  }));
  const prepare = vi.fn(async () => ({})),
    send = vi.fn(async () => ({}));
  const resolveConfiguration = vi.fn(
    async (_tx: unknown, _scope: unknown, authority: { authorize(): Promise<boolean> }) => {
      during.push(await authority.authorize());
      return {
        providerAccountReference: id(10),
        environment: "Test" as const,
        workforce: {},
        businessDate: {},
      };
    },
  );
  const approve = createMerchantOrdinaryRefundApproval({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: {
      authorize: vi.fn(async () => ({ sessionReference: id(11) })),
    } as unknown as Options["authentication"],
    resolveConfiguration: resolveConfiguration as unknown as Options["resolveConfiguration"],
    prepare,
    send,
    retentionPolicyCode: "TEST",
    retentionPolicyVersion: 1,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: { orderReference: id(6), requestReference: id(7), approvalReference: id(12) },
  };
  return { approve, input, allowed, during, prepare, send, rolledBack: () => rolledBack };
}
it("WP-2423: approves resolving the approver in full only at the start and before the commit", async () => {
  const f = setup();
  const result = await f.approve(f.input);
  expect(result).toMatchObject({ status: "Approved", replayed: false });
  // Configuration, escalation, subject, reader, card machine, approval source, approval store
  // (this Order, then another Order).
  expect(f.during).toEqual([true, true, true, true, true, true, true, false]);
  expect(doubles.scope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // The approval committed before the separate preparation and send commands ran.
  expect(doubles.record).toHaveBeenCalledOnce();
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledOnce();
  // The guard ends with the run.
  const owner = doubles.escalation.mock.calls[0]?.[0] as { authorize: Authorize };
  expect(await owner.authorize({}, { ...scope, orderReference: id(6) })).toBe(false);
});
it("WP-2423: refuses an approver without current permission before any owner read", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.approve(f.input)).rejects.toMatchObject({ code: "Denied" });
  expect(doubles.escalation).not.toHaveBeenCalled();
});
it("WP-2423: a permission withdrawn or Session ended during approval refuses it before commit and sends nothing", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const error = await f.approve(f.input).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(MerchantRefundApprovalError);
  expect(error).toMatchObject({ code: "Denied" });
  // Thrown inside the transaction callback, so the recorded approval does not commit.
  expect(f.rolledBack()).toBeInstanceOf(MerchantRefundApprovalError);
  expect(doubles.record).toHaveBeenCalledOnce();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});
