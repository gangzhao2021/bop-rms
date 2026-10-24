import { describe, expect, it, vi } from "vitest";
import { OrdinaryRefundClientError } from "./ordinary-refund-client.js";
import { OrdinaryRefundExecutionError } from "./ordinary-refund-execution-client.js";
import { OrdinaryRefundPreparationClientError } from "./ordinary-refund-preparation-client.js";
import {
  createRefundRun,
  RefundRunError,
  refundRunFailureText,
  refundRunProgressText,
  refundRunRetryLabel,
  refundRunUncertain,
  type RefundRunRequest,
  type RefundRunStep,
} from "./ordinary-refund-run.js";

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const order = id(1);

function setup(
  options: {
    approvalRequired?: boolean | null;
    attempts?: readonly string[];
    finalState?: string;
    sendAfterRequest?: boolean;
  } = {},
) {
  let next = 100;
  const newReference = vi.fn(() => id(next++));
  const recorded: RefundRunRequest & { amountMinor: string } = {
    requestReference: id(2),
    operationReference: id(3),
    paymentAttemptReferences: options.attempts ?? [id(4)],
    approvalRequired: options.approvalRequired ?? false,
    amountMinor: "1130",
  };
  const calls: string[] = [];
  const ports = {
    request: vi.fn(async () => {
      calls.push("request");
      return recorded;
    }),
    prepare: vi.fn(async (command: { paymentAttemptReference: string }) => {
      calls.push("prepare:" + command.paymentAttemptReference);
      return {};
    }),
    send: vi.fn(async (command: { operationReference: string }) => {
      calls.push("send:" + command.operationReference);
      return {};
    }),
    check: vi.fn(async (command: { operationReference: string }) => {
      calls.push("check:" + command.operationReference);
      return {};
    }),
    status: vi.fn(async (operationReference: string) => {
      calls.push("status:" + operationReference);
      return recorded.paymentAttemptReferences.map((paymentAttemptReference) => ({
        paymentAttemptReference,
        state: options.finalState ?? "Confirmed",
      }));
    }),
  };
  const run = createRefundRun({
    orderReference: order,
    newReference,
    sendAfterRequest: options.sendAfterRequest ?? true,
    ports,
  });
  return { run, ports, calls, recorded };
}
const signal = () => new AbortController().signal;

describe("WP-2423 item 6: one confirmation records, prepares, sends and checks a refund", () => {
  it("runs every step in order with one set of references and reports the real answer", async () => {
    const { run, ports, calls } = setup();
    const steps: RefundRunStep[] = [];
    const outcome = await run.run(signal(), (step) => steps.push(step));
    expect(outcome.kind).toBe("Refunded");
    expect(steps).toEqual(["Request", "Prepare", "Send", "Check"]);
    const first = (mock: { mock: { calls: readonly (readonly unknown[])[] } }) =>
      (mock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    const prepared = first(ports.prepare),
      sent = first(ports.send),
      checked = first(ports.check);
    expect(prepared).toMatchObject({
      orderReference: order,
      requestReference: id(2),
      paymentAttemptReference: id(4),
      approvalReference: null,
    });
    // The send and the check name the operation just prepared, never a new one.
    expect(sent.operationReference).toBe(prepared.operationReference);
    expect(sent).toMatchObject({ orderReference: order, requestReference: id(2) });
    expect(checked.operationReference).toBe(prepared.operationReference);
    expect(calls).toEqual([
      "request",
      "prepare:" + id(4),
      "send:" + String(prepared.operationReference),
      "check:" + String(prepared.operationReference),
      "status:" + id(3),
    ]);
    // A finished run does nothing more.
    await expect(run.run(signal())).resolves.toBe(outcome);
    expect(calls).toHaveLength(5);
  });

  it("says the refund is waiting for the card provider's answer when it is not confirmed", async () => {
    const { run } = setup({ finalState: "NeedsReconciliation" });
    await expect(run.run(signal())).resolves.toMatchObject({ kind: "WaitingForAnswer" });
  });

  const failures: readonly [RefundRunStep, "request" | "prepare" | "send" | "check" | "status"][] =
    [
      ["Request", "request"],
      ["Prepare", "prepare"],
      ["Send", "send"],
      ["Check", "check"],
      ["Check", "status"],
    ];
  it.each(failures)(
    "after an unconfirmed %s (%s) a retry resumes there with the same command",
    async (step, port) => {
      const { run, ports } = setup();
      const lost =
        port === "request" || port === "status"
          ? new OrdinaryRefundClientError("OutcomeUnknown")
          : port === "prepare"
            ? new OrdinaryRefundPreparationClientError("OutcomeUnknown")
            : new OrdinaryRefundExecutionError("OutcomeUnknown");
      (ports[port] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(lost);
      const error = await run.run(signal()).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(RefundRunError);
      expect((error as RefundRunError).step).toBe(step);
      expect((error as RefundRunError).cause).toBe(lost);
      expect(refundRunUncertain(error as RefundRunError)).toBe(true);
      expect(run.resumeStep()).toBe(step);
      expect(run.mayHaveSent).toBe(port === "send" || port === "check" || port === "status");
      await expect(run.run(signal())).resolves.toMatchObject({ kind: "Refunded" });
      // Each step ran once, except the failed one, retried with exactly the same command.
      for (const name of ["request", "prepare", "send", "check", "status"] as const) {
        const mock = ports[name] as ReturnType<typeof vi.fn>;
        expect(mock).toHaveBeenCalledTimes(name === port ? 2 : 1);
      }
      const retried = (ports[port] as ReturnType<typeof vi.fn>).mock.calls;
      expect(JSON.stringify(retried[1]?.[0])).toBe(JSON.stringify(retried[0]?.[0]));
      expect(run.resumeStep()).toBeNull();
    },
  );

  it("a refused step is retried with the same references too (the server replays, never repeats)", async () => {
    const { run, ports } = setup();
    ports.send.mockRejectedValueOnce(new OrdinaryRefundExecutionError("PermissionDenied"));
    const error = (await run.run(signal()).catch((value: unknown) => value)) as RefundRunError;
    expect(error.step).toBe("Send");
    expect(refundRunUncertain(error)).toBe(false);
    await run.run(signal());
    expect(ports.send.mock.calls[1]?.[0]).toEqual(ports.send.mock.calls[0]?.[0]);
    expect(ports.prepare).toHaveBeenCalledTimes(1);
  });

  it("a refund needing an owner's approval stops after the request: nothing is prepared or sent", async () => {
    const { run, ports } = setup({ approvalRequired: true });
    const steps: RefundRunStep[] = [];
    await expect(run.run(signal(), (step) => steps.push(step))).resolves.toMatchObject({
      kind: "AwaitingApproval",
      request: { requestReference: id(2) },
    });
    expect(steps).toEqual(["Request"]);
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.send).not.toHaveBeenCalled();
    expect(ports.check).not.toHaveBeenCalled();
    await expect(run.run(signal())).resolves.toMatchObject({ kind: "AwaitingApproval" });
    expect(ports.request).toHaveBeenCalledTimes(1);
  });

  it("an approval-required request whose result was lost is retried, then still stops for approval", async () => {
    const { run, ports } = setup({ approvalRequired: true });
    ports.request.mockRejectedValueOnce(new OrdinaryRefundClientError("OutcomeUnknown"));
    await expect(run.run(signal())).rejects.toMatchObject({ step: "Request" });
    await expect(run.run(signal())).resolves.toMatchObject({ kind: "AwaitingApproval" });
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("a card-machine refund is only recorded: staff refund it on the machine", async () => {
    const { run, ports } = setup({ sendAfterRequest: false });
    await expect(run.run(signal())).resolves.toMatchObject({ kind: "RecordedOnly" });
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("prepares every payment before sending any, so a refusal leaves nothing sent", async () => {
    const { run, ports, calls } = setup({ attempts: [id(4), id(5)] });
    ports.prepare
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(new OrdinaryRefundPreparationClientError("Conflict"));
    await expect(run.run(signal())).rejects.toMatchObject({ step: "Prepare" });
    expect(ports.send).not.toHaveBeenCalled();
    expect(run.mayHaveSent).toBe(false);
    calls.length = 0;
    await expect(run.run(signal())).resolves.toMatchObject({ kind: "Refunded" });
    expect(ports.prepare).toHaveBeenCalledTimes(3);
    expect(ports.prepare.mock.calls[2]?.[0]).toEqual(ports.prepare.mock.calls[1]?.[0]);
    expect(calls.filter((call) => call.startsWith("send:"))).toHaveLength(2);
  });

  it("continues a recorded request from the step it reached (already prepared: only sent)", async () => {
    const ports = {
      prepare: vi.fn(async () => ({})),
      send: vi.fn(async () => ({})),
      check: vi.fn(async () => ({})),
      status: vi.fn(async () => [{ paymentAttemptReference: id(4), state: "NeedsReconciliation" }]),
    };
    let next = 200;
    const run = createRefundRun<RefundRunRequest>({
      orderReference: order,
      newReference: () => id(next++),
      sendAfterRequest: true,
      ports,
      recorded: {
        requestReference: id(2),
        operationReference: id(3),
        legs: [
          {
            paymentAttemptReference: id(4),
            preparedOperationReference: id(9),
            approvalReference: id(10),
          },
        ],
      },
    });
    expect(run.resumeStep()).toBe("Send");
    await expect(run.run(signal())).resolves.toMatchObject({ kind: "WaitingForAnswer" });
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.send.mock.calls[0]).toBeDefined();
    expect((ports.send.mock.calls[0] as unknown[])[0]).toMatchObject({
      operationReference: id(9),
      approvalReference: id(10),
      requestReference: id(2),
    });
    expect(ports.status).toHaveBeenCalledWith(id(3), expect.anything());
  });

  it("never runs two attempts of the same run at once", async () => {
    const { run, ports } = setup();
    let release: () => void = () => undefined;
    ports.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              requestReference: id(2),
              operationReference: id(3),
              paymentAttemptReferences: [id(4)],
              approvalRequired: false,
              amountMinor: "1130",
            });
        }),
    );
    const first = run.run(signal());
    await expect(run.run(signal())).rejects.toThrow("REFUND_RUN_BUSY");
    release();
    await expect(first).resolves.toMatchObject({ kind: "Refunded" });
  });
});

describe("WP-2423 item 6: staff wording follows what really happened", () => {
  it("shows progress per step and never calls a refund sent before the send step", () => {
    expect(refundRunProgressText("Request")).toBe("Recording refund…");
    expect(refundRunProgressText("Prepare")).toBe("Recording refund…");
    expect(refundRunProgressText("Send")).toBe("Sending to the card provider…");
    expect(refundRunProgressText("Check")).toBe("Checking the card provider's answer…");
    const prepare = (code: ConstructorParameters<typeof OrdinaryRefundPreparationClientError>[0]) =>
      refundRunFailureText(
        new RefundRunError("Prepare", new OrdinaryRefundPreparationClientError(code)),
      );
    for (const code of ["OutcomeUnknown", "PermissionDenied", "Conflict", "Unavailable"] as const) {
      expect(prepare(code)).toMatch(/recorded/u);
      expect(prepare(code)).not.toMatch(/\bSent\b|was sent/u);
    }
    expect(prepare("OutcomeUnknown")).toContain("Nothing has been sent");
    const send = (code: ConstructorParameters<typeof OrdinaryRefundExecutionError>[0]) =>
      refundRunFailureText(new RefundRunError("Send", new OrdinaryRefundExecutionError(code)));
    expect(send("OutcomeUnknown")).toContain("never refunded twice");
    expect(send("PermissionDenied")).toContain("was not sent");
    expect(refundRunFailureText(new RefundRunError("Check", new TypeError("network")))).toContain(
      "was sent to the card provider",
    );
    expect(refundRunRetryLabel("Request")).toBe("Retry same refund request");
    expect(refundRunRetryLabel("Prepare")).toBe("Continue sending this refund");
    expect(refundRunRetryLabel("Send")).toBe("Continue sending this refund");
    expect(refundRunRetryLabel("Check")).toBe("Check the card provider's answer again");
  });
  it("uses no internal step names in staff text", () => {
    const texts = (["Prepare", "Send", "Check"] as const).flatMap((step) =>
      [
        new OrdinaryRefundPreparationClientError("OutcomeUnknown"),
        new OrdinaryRefundExecutionError("Unavailable"),
        new TypeError("x"),
      ].map((cause) => refundRunFailureText(new RefundRunError(step, cause))),
    );
    for (const text of texts)
      expect(text).not.toMatch(/dispatch|reconcil|preparation|operation|Provider\b/u);
  });
});
