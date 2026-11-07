import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  lazyModule,
  loadChunk,
  PageChunkBoundary,
  PageChunkError,
  retryFailedChunks,
} from "./route-chunks.js";

let reload: ReturnType<typeof vi.fn>;
let online: boolean;
beforeEach(() => {
  vi.useFakeTimers();
  reload = vi.fn();
  online = true;
  const stored = new Map<string, string>();
  vi.stubGlobal("location", { reload });
  vi.stubGlobal("navigator", {
    get onLine() {
      return online;
    },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const missing = () => Promise.reject(new TypeError("Failed to fetch dynamically imported module"));

it("asks once more when a screen's code does not arrive on the first try", async () => {
  const load = vi.fn().mockImplementationOnce(missing).mockResolvedValueOnce({ page: 1 });
  const result = loadChunk(load);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(result).resolves.toEqual({ page: 1 });
  expect(load).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
});

it("reloads once to pick up new files when the code is still missing online, never in a loop", async () => {
  let settled = false;
  void loadChunk(missing).then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  // Still missing right after that reload: staff get the retry message instead of another reload.
  const again = loadChunk(missing);
  const outcome = expect(again).rejects.toBeInstanceOf(PageChunkError);
  await vi.advanceTimersByTimeAsync(1_000);
  await outcome;
  expect(reload).toHaveBeenCalledTimes(1);
});

it("does not reload while offline; the screen reports it and loads again on retry", async () => {
  online = false;
  const load = vi
    .fn()
    .mockImplementationOnce(missing)
    .mockImplementationOnce(missing)
    .mockResolvedValue({ page: 2 });
  const screen = lazyModule(load);
  const first = screen.preload();
  const outcome = expect(first).rejects.toBeInstanceOf(PageChunkError);
  await vi.advanceTimersByTimeAsync(1_000);
  await outcome;
  expect(reload).not.toHaveBeenCalled();
  // React keeps showing the failure until staff press "Try again".
  expect(screen.preload()).toBe(first);
  retryFailedChunks();
  await expect(screen.preload()).resolves.toEqual({ page: 2 });
  expect(screen.loaded()).toEqual({ page: 2 });
});

it("ignores a failed background fetch: no reload, and the screen still loads when opened", async () => {
  const load = vi.fn().mockImplementationOnce(missing).mockResolvedValue({ page: 3 });
  const screen = lazyModule(load);
  screen.prefetch();
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).not.toHaveBeenCalled();
  expect(screen.loaded()).toBeUndefined();
  await expect(screen.preload()).resolves.toEqual({ page: 3 });
});

it("shows plain words and Try again for missing code, and passes other faults on", () => {
  const boundary = new PageChunkBoundary({ resetKey: "/app/settlement", children: null });
  boundary.state = PageChunkBoundary.getDerivedStateFromError(new PageChunkError("x"));
  const html = renderToStaticMarkup(<>{boundary.render()}</>);
  expect(html).toContain("This page didn&#x27;t load");
  expect(html).toContain("Try again");
  expect(html).not.toMatch(/PAGE_CHUNK|TypeError|import/u);
  boundary.state = PageChunkBoundary.getDerivedStateFromError(new Error("render fault"));
  expect(() => boundary.render()).toThrow("render fault");
});
