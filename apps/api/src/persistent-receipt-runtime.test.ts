import { describe, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPersistentReceiptRuntime } from "./persistent-receipt-runtime.js";
const calls = vi.hoisted(() => ({ issue: vi.fn(), factory: vi.fn() }));
vi.mock("./original-receipt-issuance.js", () => ({
  createOriginalReceiptIssuance: (options: unknown) => {
    calls.factory(options);
    return calls.issue;
  },
}));
const id = (n: number) => "0190ed17-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const tx = { query: vi.fn() },
    states: string[] = [];
  const options = {
    transactions: {
      run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> => {
        states.push("begin");
        try {
          const result = await work(tx);
          states.push("commit");
          return result;
        } catch (error) {
          states.push("rollback");
          throw error;
        }
      },
    },
    sources: {
      scope: {
        brandReference: id(1),
        storeReference: id(2),
        providerAccountReference: id(3),
        tenantReference: id(4),
        environment: "Test" as const,
      },
      authorize: async () => true,
    },
    template: {
      store: {
        tenantReference: id(4),
        brandReference: id(1),
        storeReference: id(2),
        timeZone: "America/Toronto",
        configurationType: "STORE_CONFIGURATION",
        purposeCode: "STORE_CONFIGURATION",
        requiredLiveGateRequirementCodes: ["STORE_READY"],
        authorize: async () => true,
        hashContent: () => "sha256:" + "a".repeat(64),
      },
      templatePublication: {
        tenantReference: id(4),
        templateReference: id(5),
        familyReference: id(6),
        configurationType: "RECEIPT_TEMPLATE",
        purposeCode: "RECEIPT_ISSUANCE",
        authorize: async () => true,
      },
      authorize: async () => true,
    },
    authorize: async () => true,
    authorizeOrder: async () => true,
    identities: () => ({
      recordReference: id(7),
      receiptReference: id(8),
      operationReference: id(9),
    }),
    audit: async (): Promise<never> => {
      throw new Error("unconfigured Audit fixture");
    },
  };
  return { options, tx, states };
}
const request = {
  orderReference: id(10),
  observedAt: "2026-09-13T00:00:00.000Z",
  freshAfter: "2026-09-13T00:00:00.000Z",
};
describe("persistent receipt runtime assembly", () => {
  it("passes the same transaction to issuance and returns only after commit", async () => {
    const f = fixture();
    calls.issue.mockResolvedValue({ status: "Existing" });
    expect(await createPersistentReceiptRuntime(f.options).issueOriginal(request)).toEqual({
      status: "Existing",
    });
    expect(calls.issue).toHaveBeenLastCalledWith(f.tx, request);
    expect(f.states).toEqual(["begin", "commit"]);
    expect(calls.factory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sources: expect.objectContaining({
          order: expect.any(Function),
          template: expect.any(Function),
        }),
      }),
    );
  });
  it("propagates failure through runner rollback", async () => {
    const f = fixture();
    calls.issue.mockRejectedValue(new Error("synthetic source failure"));
    await expect(createPersistentReceiptRuntime(f.options).issueOriginal(request)).rejects.toThrow(
      "synthetic source failure",
    );
    expect(f.states).toEqual(["begin", "rollback"]);
  });
  it("rejects different Store scopes at construction", () => {
    const f = fixture();
    f.options.template.store.storeReference = id(99);
    expect(() => createPersistentReceiptRuntime(f.options)).toThrow(
      "DIGITAL_RECEIPT_INPUT_INVALID",
    );
    expect(f.states).toEqual([]);
  });
  it("rejects a different Tenant rather than mixing refund authority", () => {
    const f = fixture();
    f.options.sources.scope.tenantReference = id(99);
    expect(() => createPersistentReceiptRuntime(f.options)).toThrow(
      "DIGITAL_RECEIPT_INPUT_INVALID",
    );
  });
});
