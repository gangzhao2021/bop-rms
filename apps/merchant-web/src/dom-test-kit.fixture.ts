/**
 * Test-only helpers for components rendered into jsdom (`// @vitest-environment jsdom`): mount,
 * let promises settle, click, and type into a controlled input as a person would.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted = new Set<Root>();

/**
 * Unmounts every root `mount` made and lets React finish its scheduled work while the test
 * environment still exists, so no render runs after jsdom is torn down ("window is not defined").
 */
export async function unmountMounted(): Promise<void> {
  const roots = [...mounted];
  mounted.clear();
  await act(async () => {
    for (const root of roots) root.unmount();
  });
}

export async function mount(node: ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.add(root);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

/**
 * Waits, in real time, until `condition` holds (letting renders run between checks). Use it when
 * the work being waited for is not only promises: Web Crypto digests, for example, finish on
 * another thread, so a fixed number of `settle` rounds passes on a quiet machine and fails on a
 * busy CI runner.
 */
export async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = performance.now();
  for (;;) {
    let met = false;
    await act(async () => {
      met = condition();
      if (!met) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (met) return;
    if (performance.now() - started > timeoutMs)
      throw new Error(`condition not met within ${timeoutMs} ms: ${condition.toString()}`);
  }
}

/** Lets pending promises (and the renders they cause) finish. */
export async function settle(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => {
    element.click();
  });
}

export async function typeInto(element: Element | null | undefined, value: string): Promise<void> {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
    throw new Error("no input");
  const prototype = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function selectValue(element: Element | null | undefined, value: string) {
  if (!(element instanceof HTMLSelectElement)) throw new Error("no select");
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function buttonNamed(container: ParentNode, name: string | RegExp) {
  return [...container.querySelectorAll("button")].find((button) =>
    typeof name === "string"
      ? button.textContent?.trim() === name
      : name.test(button.textContent ?? ""),
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
