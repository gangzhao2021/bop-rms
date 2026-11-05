import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KitchenStepClientError, type KitchenStepReply } from "./kitchen-step-client.js";
import {
  createKitchenStepQueue,
  kitchenStepHoldMs,
  kitchenStepRetryDelaysMs,
  type KitchenTap,
} from "./kitchen-step-queue.js";

const reply: KitchenStepReply = { occurredAt: "2026-10-26T22:14:00.000Z", lines: [] };
function setup() {
  let authority = true;
  const phases: string[][] = [];
  const pending: {
    resolve: (value: KitchenStepReply) => void;
    reject: (error: unknown) => void;
    tap: KitchenTap<string>;
  }[] = [];
  const send = vi.fn(
    (tap: KitchenTap<string>) =>
      new Promise<KitchenStepReply>((resolve, reject) => {
        pending.push({ resolve, reject, tap });
      }),
  );
  const onConfirmed = vi.fn();
  const onRefused = vi.fn();
  const onNotSent = vi.fn();
  let current: readonly KitchenTap<string>[] = [];
  const queue = createKitchenStepQueue<string>({
    send,
    authority: () => authority,
    onChange: (taps) => {
      current = taps;
      phases.push(taps.map((tap) => tap.phase));
    },
    onConfirmed,
    onRefused,
    onNotSent,
  });
  return {
    queue,
    send,
    pending,
    onConfirmed,
    onRefused,
    onNotSent,
    phases,
    taps: () => current,
    lose: () => {
      authority = false;
    },
    gain: () => {
      authority = true;
    },
  };
}
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("DEC-KITCHEN-ONE-TAP between a tap and the server", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds a tap, then sends it; undo within the hold sends no POST", async () => {
    const s = setup();
    const id = s.queue.tap("Finish", ["a"]);
    await vi.advanceTimersByTimeAsync(kitchenStepHoldMs - 1);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.queue.undo(id)).toBe(true);
    expect(s.taps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(kitchenStepHoldMs * 2);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.onConfirmed).not.toHaveBeenCalled();

    const sent = s.queue.tap("Finish", ["b"]);
    await vi.advanceTimersByTimeAsync(kitchenStepHoldMs);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.queue.undo(sent)).toBe(false);
  });
  it("sends one at a time, in the order tapped", async () => {
    const s = setup();
    s.queue.tap("Finish", ["first"]);
    await vi.advanceTimersByTimeAsync(10);
    s.queue.tap("Finish", ["second"]);
    await vi.advanceTimersByTimeAsync(kitchenStepHoldMs);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0]?.[0].targets).toEqual(["first"]);
    expect(s.taps().map((tap) => tap.phase)).toEqual(["Sending", "Waiting"]);
    s.pending[0]?.resolve(reply);
    await flush();
    expect(s.onConfirmed).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(s.send.mock.calls[1]?.[0].targets).toEqual(["second"]);
  });
  it("a lost answer goes again by itself and blocks only its own lines", async () => {
    const s = setup();
    s.queue.tap("Finish", ["lost"]);
    await vi.advanceTimersByTimeAsync(1_000);
    s.queue.tap("Finish", ["other"]);
    await vi.advanceTimersByTimeAsync(kitchenStepHoldMs - 1_000);
    s.pending[0]?.reject(new KitchenStepClientError("OutcomeUnknown"));
    await flush();
    expect(s.taps().map((tap) => tap.phase)).toEqual(["Retrying", "Holding"]);
    // Another tap keeps going meanwhile.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.send.mock.calls[1]?.[0].targets).toEqual(["other"]);
    s.pending[1]?.resolve(reply);
    await flush();
    // The same tap again, at 3 s, 8 s and 20 s after each failure, then the cook decides.
    await vi.advanceTimersByTimeAsync(kitchenStepRetryDelaysMs[0] - 1_000);
    expect(s.pending[2]?.tap.targets).toEqual(["lost"]);
    s.pending[2]?.reject(new KitchenStepClientError("Busy"));
    await flush();
    await vi.advanceTimersByTimeAsync(kitchenStepRetryDelaysMs[1]);
    s.pending[3]?.reject(new KitchenStepClientError("OutcomeUnknown"));
    await flush();
    await vi.advanceTimersByTimeAsync(kitchenStepRetryDelaysMs[2]);
    s.pending[4]?.reject(new KitchenStepClientError("OutcomeUnknown"));
    await flush();
    expect(s.taps().map((tap) => tap.phase)).toEqual(["Failed"]);
    expect(s.send).toHaveBeenCalledTimes(5);
    // The cook asks for it once more, the same tap; or gives up and the board stays usable.
    s.queue.retry(s.taps()[0]?.id ?? 0);
    await flush();
    expect(s.send).toHaveBeenCalledTimes(6);
    s.pending[5]?.reject(new KitchenStepClientError("OutcomeUnknown"));
    await flush();
    expect(s.taps().map((tap) => tap.phase)).toEqual(["Failed"]);
    s.queue.dismiss(s.taps()[0]?.id ?? 0);
    expect(s.taps()).toEqual([]);
  });
  it("a queued tap is not sent after the board goes stale", async () => {
    const s = setup();
    s.queue.tap("Finish", ["held"]);
    await vi.advanceTimersByTimeAsync(10);
    s.lose();
    await vi.advanceTimersByTimeAsync(kitchenStepHoldMs);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.taps()).toEqual([]);
    expect(s.onNotSent).toHaveBeenCalledTimes(1);
    expect(s.onNotSent.mock.calls[0]?.[0][0].targets).toEqual(["held"]);
  });
  it("when the connection goes, unsent taps return at once and a lost answer waits for the cook", async () => {
    const s = setup();
    s.queue.tap("Finish", ["lost"]);
    await vi.advanceTimersByTimeAsync(kitchenStepHoldMs);
    s.pending[0]?.reject(new KitchenStepClientError("OutcomeUnknown"));
    await flush();
    s.queue.tap("Finish", ["unsent"]);
    s.lose();
    s.queue.authorityLost();
    expect(s.onNotSent.mock.calls[0]?.[0][0].targets).toEqual(["unsent"]);
    expect(s.taps().map((tap) => [tap.targets[0], tap.phase])).toEqual([["lost", "Failed"]]);
    // Never sent minutes later on its own, and not on demand while there is no connection.
    await vi.advanceTimersByTimeAsync(600_000);
    s.queue.retry(s.taps()[0]?.id ?? 0);
    expect(s.send).toHaveBeenCalledTimes(1);
    s.gain();
    s.queue.retry(s.taps()[0]?.id ?? 0);
    await flush();
    expect(s.send).toHaveBeenCalledTimes(2);
  });
  it("a body the server refuses outright is not sent again", async () => {
    const s = setup();
    s.queue.tap("Start", ["refused"]);
    await vi.advanceTimersByTimeAsync(kitchenStepHoldMs);
    s.pending[0]?.reject(new KitchenStepClientError("PermissionDenied"));
    await flush();
    expect(s.onRefused).toHaveBeenCalledWith(expect.anything(), "PermissionDenied");
    expect(s.taps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.send).toHaveBeenCalledTimes(1);
  });
});
