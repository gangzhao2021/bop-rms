import { describe, expect, it, vi } from "vitest";
import { reloadOnEntryCodeChange } from "./entry-code-change.js";

// Guest entry (v15 batch 5): on DEMO Store's entry page at "/", opening Test Merchant 2's pickup
// link in the same tab changed only the fragment, and the page kept showing DEMO Café.
describe("a Store's code opened in the same tab", () => {
  const setup = (hash: string) => {
    const listeners = new Map<string, () => void>();
    const reload = vi.fn();
    let current = hash;
    const stop = reloadOnEntryCodeChange({
      events: {
        addEventListener: ((type: string, listener: () => void) =>
          void listeners.set(type, listener)) as Window["addEventListener"],
        removeEventListener: ((type: string) =>
          void listeners.delete(type)) as Window["removeEventListener"],
      },
      hash: () => current,
      reload,
    });
    return {
      reload,
      stop,
      change: (next: string) => {
        current = next;
        listeners.get("hashchange")?.();
      },
      listening: () => listeners.has("hashchange"),
    };
  };
  it("starts the page again at the new pickup link, table code or table launcher, once", () => {
    for (const next of [
      "#pickup=0190aa21-0000-7000-8000-0000000000b2",
      "#qr=aaa.bbb.ccc",
      "#internal-dining=table-1",
    ]) {
      const page = setup("");
      page.change(next);
      page.change(next);
      expect(page.reload).toHaveBeenCalledTimes(1);
    }
  });
  it("ignores any other fragment, and stops listening when asked", () => {
    const page = setup("");
    page.change("#cart-content");
    page.change("");
    expect(page.reload).not.toHaveBeenCalled();
    page.stop();
    expect(page.listening()).toBe(false);
  });
});
