import { isSafeUpdatePath } from "./service-worker-policy.js";

export type PwaUpdateState =
  { readonly status: "idle" } | { readonly status: "waiting" } | { readonly status: "applying" };

export interface PwaUpdateStore {
  getState(): PwaUpdateState;
  notifyWaiting(activate: () => Promise<void>): void;
  activate(pathname: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createPwaUpdateStore(): PwaUpdateStore {
  let state: PwaUpdateState = { status: "idle" };
  let activateWaiting: (() => Promise<void>) | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PwaUpdateState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return Object.freeze({
    getState: () => state,
    notifyWaiting(activate: () => Promise<void>) {
      if (typeof activate !== "function" || state.status === "applying") return;
      activateWaiting = activate;
      publish({ status: "waiting" });
    },
    async activate(pathname: string) {
      if (state.status !== "waiting" || !activateWaiting || !isSafeUpdatePath(pathname)) return;
      const activate = activateWaiting;
      activateWaiting = null;
      publish({ status: "applying" });
      try {
        await activate();
      } catch {
        activateWaiting = activate;
        publish({ status: "waiting" });
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export const pwaUpdateStore = createPwaUpdateStore();
