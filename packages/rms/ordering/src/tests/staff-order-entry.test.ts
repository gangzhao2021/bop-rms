import { describe, expect, it, vi } from "vitest";
import {
  executeStaffOrderEntry,
  parseOrderingReference,
  StaffOrderEntryError,
  type StaffOrderEntryPorts,
  type StaffOrderEntryReceipt,
} from "../index.js";

const id = (n: number) =>
  parseOrderingReference(`018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const hash = `sha256:${"a".repeat(64)}`;

function command(action = "Submit", payload: Record<string, unknown> = {}) {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    purpose: "StaffOrderEntry",
    operationReference: id(5),
    observedAt: "2026-09-20T18:00:00.000Z",
    action,
    sourceChannel: "Pos",
    payload:
      action === "Submit"
        ? {
            cartReference: id(6),
            expectedCartVersion: 3,
            quoteReference: id(7),
            checkoutEvidenceReference: id(8),
            submissionReference: id(9),
            ...payload,
          }
        : payload,
  };
}

function receipt(
  overrides: Partial<Omit<StaffOrderEntryReceipt, "intentHash" | "auditReference">> = {},
) {
  return {
    operationReference: id(5),
    action: "Submit" as const,
    outcome: "Applied" as const,
    sharedContract: "Ordering.Submit.v1" as const,
    cartReference: id(6),
    cartVersion: 4,
    quoteReference: id(7),
    orderReference: id(10),
    batchReference: id(11),
    paymentAttemptReference: null,
    terminalStatus: "NotStarted" as const,
    allergenReadiness: "ReviewCurrent" as const,
    sourceChannel: "Pos" as const,
    createdActorReference: id(4),
    submittedActorReference: id(4),
    ...overrides,
  } as Omit<StaffOrderEntryReceipt, "intentHash" | "auditReference">;
}

function ports(shared = receipt()): StaffOrderEntryPorts & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    authorization: {
      authorize: vi.fn(async (input) => {
        calls.push("authorize");
        expect(input.requiredPermissions).toEqual([
          "ordering.operate",
          "ordering.order.create_staff",
        ]);
        return { authorized: true as const, auditReference: id(12) };
      }),
    },
    idempotency: {
      resolve: vi.fn(async () => {
        calls.push("resolve");
        return null;
      }),
      commit: vi.fn(async (value) => {
        calls.push("commit");
        return value;
      }),
    },
    sharedContracts: {
      execute: vi.fn(async (input) => {
        calls.push("execute");
        expect(input.sourceChannel).toBe("Pos");
        expect(input.actorReference).toBe(id(4));
        return shared;
      }),
    },
    references: { hashIntent: vi.fn(() => hash), equals: vi.fn((a, b) => a === b) },
  };
}

describe("Staff Order Entry shared-contract orchestration", () => {
  it("authorizes named staff before reads and submits one canonical Order / Batch", async () => {
    const adapter = ports();
    const result = await executeStaffOrderEntry(command(), adapter);
    expect(adapter.calls).toEqual(["authorize", "resolve", "execute", "commit"]);
    expect(result).toMatchObject({
      sourceChannel: "Pos",
      orderReference: id(10),
      batchReference: id(11),
      submittedActorReference: id(4),
    });
  });

  it("replays the same receipt without invoking the shared mutation", async () => {
    const adapter = ports();
    const prior = { ...receipt(), intentHash: hash, auditReference: id(12) };
    adapter.idempotency.resolve = vi.fn(async () => prior);
    expect(await executeStaffOrderEntry(command(), adapter)).toEqual(prior);
    expect(adapter.sharedContracts.execute).not.toHaveBeenCalled();
  });

  it("fails closed before reads when either required permission is unavailable", async () => {
    const adapter = ports();
    adapter.authorization.authorize = vi.fn(async () => null);
    await expect(executeStaffOrderEntry(command(), adapter)).rejects.toMatchObject({
      code: "STAFF_ORDER_ENTRY_PERMISSION_DENIED",
    });
    expect(adapter.idempotency.resolve).not.toHaveBeenCalled();
  });

  it("blocks submission when a shared adapter cannot prove an allergen-ready state", async () => {
    const adapter = ports(receipt({ allergenReadiness: "ReviewRequired" as never }));
    await expect(executeStaffOrderEntry(command(), adapter)).rejects.toMatchObject({
      code: "STAFF_ORDER_ENTRY_ALLERGEN_REVIEW_REQUIRED",
    });
    expect(adapter.idempotency.commit).not.toHaveBeenCalled();
  });

  it("accepts only a pending cashless Terminal handoff and never a success claim", async () => {
    const terminal = receipt({
      action: "StartTerminalPayment",
      sharedContract: "Payment.TerminalStart.v1",
      cartReference: null,
      cartVersion: null,
      orderReference: id(10),
      batchReference: id(11),
      paymentAttemptReference: id(13),
      terminalStatus: "Pending",
      allergenReadiness: "ReviewCurrent",
      submittedActorReference: null,
    });
    const adapter = ports(terminal);
    const result = await executeStaffOrderEntry(
      command("StartTerminalPayment", {
        orderReference: id(10),
        batchReference: id(11),
        quoteReference: id(7),
        paymentOperationReference: id(14),
      }),
      adapter,
    );
    expect(result.terminalStatus).toBe("Pending");
    await expect(
      executeStaffOrderEntry(
        command("StartTerminalPayment", {
          orderReference: id(10),
          batchReference: id(11),
          quoteReference: id(7),
          paymentOperationReference: id(14),
        }),
        ports({ ...terminal, terminalStatus: "Succeeded" as never }),
      ),
    ).rejects.toBeInstanceOf(StaffOrderEntryError);
  });

  it("rejects arbitrary financial or status override fields at the boundary", async () => {
    const adapter = ports();
    await expect(
      executeStaffOrderEntry(command("Submit", { amountMinor: 1 }), adapter),
    ).rejects.toMatchObject({ code: "STAFF_ORDER_ENTRY_INVALID" });
    expect(adapter.authorization.authorize).not.toHaveBeenCalled();
  });
});
