import { expect, it, vi } from "vitest";
import { protectCustomerHistoryRestore } from "./history-recovery.js";

function fixture() {
  const target = new EventTarget();
  const registrations = vi.spyOn(target, "addEventListener");
  const actions: string[] = [];
  const cover = vi.fn(() => actions.push("cover"));
  const reload = vi.fn(() => actions.push("reload"));
  const remove = protectCustomerHistoryRestore({
    events: target as unknown as Window,
    cover,
    reload,
  });
  const dispatch = (name: "pagehide" | "pageshow", persisted: boolean) => {
    const event = new Event(name);
    Object.defineProperty(event, "persisted", { value: persisted });
    target.dispatchEvent(event);
  };
  return { actions, cover, reload, remove, dispatch, registrations };
}

it("leaves first load and ordinary non-persisted navigation to normal startup", () => {
  const f = fixture();
  f.dispatch("pageshow", false);
  f.dispatch("pagehide", false);
  expect(f.actions).toEqual([]);
});

it("covers a cached document before departure and before its one foreground reload", () => {
  const f = fixture();
  f.dispatch("pagehide", true);
  expect(f.actions).toEqual(["cover"]);
  f.dispatch("pageshow", true);
  f.dispatch("pageshow", true);
  expect(f.actions).toEqual(["cover", "cover", "reload"]);
});

it("covers a persisted restore even when no prior pagehide was observed", () => {
  const f = fixture();
  f.dispatch("pageshow", true);
  expect(f.actions).toEqual(["cover", "reload"]);
});

it("removes both listeners without scheduling a reload", () => {
  const f = fixture();
  f.remove();
  f.dispatch("pagehide", true);
  f.dispatch("pageshow", true);
  expect(f.actions).toEqual([]);
});

it("keeps private content covered if reload fails and does not loop", () => {
  const f = fixture();
  f.reload.mockImplementationOnce(() => {
    throw new Error("navigation unavailable");
  });
  const show = f.registrations.mock.calls.find(([name]) => name === "pageshow")?.[1];
  if (typeof show !== "function") throw new Error("missing restore listener");
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  expect(() => show(event)).toThrow("navigation unavailable");
  expect(f.cover).toHaveBeenCalledOnce();
  f.dispatch("pageshow", true);
  expect(f.reload).toHaveBeenCalledOnce();
});
