/**
 * Test-only helpers for components rendered into jsdom (`// @vitest-environment jsdom`): mount,
 * let promises settle, click, and type into a controlled input as a person would.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function mount(node: ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
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
