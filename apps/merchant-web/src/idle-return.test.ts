import { describe, expect, it, vi } from "vitest";
import {
  clearSignInMark,
  idleReturnLeft,
  idleReturnNotice,
  markSignInEnded,
  retrySignOut,
  signInMarkedEnded,
  type IdleReturnStorage,
} from "./idle-return.js";

const memory = (): IdleReturnStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
};

describe("M61: a shared tablet returns to the staff list after minutes without use", () => {
  it("counts only staff input, warns 30 seconds before, and never applies without minutes", () => {
    const at = 1_000_000;
    expect(idleReturnNotice({ minutes: null, lastInputAt: 0, now: at })).toEqual({ kind: "None" });
    expect(idleReturnNotice({ minutes: 5, lastInputAt: at, now: at + 4 * 60_000 })).toEqual({
      kind: "None",
    });
    expect(
      idleReturnNotice({ minutes: 5, lastInputAt: at, now: at + 5 * 60_000 - 28_000 }),
    ).toEqual({ kind: "Warning", leftMs: 28_000 });
    expect(idleReturnNotice({ minutes: 5, lastInputAt: at, now: at + 5 * 60_000 })).toEqual({
      kind: "Return",
    });
    expect(idleReturnLeft(27_200)).toBe("0:28");
  });

  it("keeps an ended sign-in ended in this browser, by a digest and never the value", async () => {
    const store = memory();
    const csrf = "c".repeat(43);
    expect(await signInMarkedEnded(csrf, store)).toBe(false);
    await markSignInEnded(csrf, store);
    expect([...store.values.values()].join("")).not.toContain(csrf);
    expect(await signInMarkedEnded(csrf, store)).toBe(true);
    // A new PIN sign-in is another sign-in: it is not ended.
    expect(await signInMarkedEnded("d".repeat(43), store)).toBe(false);
    clearSignInMark(store);
    expect(await signInMarkedEnded(csrf, store)).toBe(false);
  });

  it("retries a sign-out that could not reach the server until it goes through", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, () => void>();
      const target = {
        addEventListener: (type: string, listener: () => void) =>
          void listeners.set(type, listener),
        removeEventListener: (type: string) => void listeners.delete(type),
      } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
      let calls = 0;
      const signOut = vi.fn(() => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error("offline")) : Promise.resolve();
      });
      const done = vi.fn();
      retrySignOut(signOut, { onDone: done, intervalMs: 1_000, target });
      await vi.advanceTimersByTimeAsync(0);
      expect(signOut).toHaveBeenCalledTimes(1);
      // Back online: tried at once.
      listeners.get("online")?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(signOut).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signOut).toHaveBeenCalledTimes(3);
      expect(done).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(signOut).toHaveBeenCalledTimes(3);
      expect(listeners.has("online")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
