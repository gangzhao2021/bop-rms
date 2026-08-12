export type ConnectivityState =
  { readonly status: "online" } | { readonly status: "offline" } | { readonly status: "restored" };

export interface ConnectivityController {
  getState(): ConnectivityState;
  setOnline(value: boolean): void;
  dismissRestored(): void;
  dispose(): void;
  subscribe(listener: () => void): () => void;
}

export function createConnectivityController(
  initiallyOnline = typeof navigator === "undefined" || navigator.onLine !== false,
): ConnectivityController {
  let state: ConnectivityState = initiallyOnline ? { status: "online" } : { status: "offline" };
  let stopped = false;
  const listeners = new Set<() => void>();
  const publish = (next: ConnectivityState) => {
    if (stopped || next.status === state.status) return;
    state = next;
    listeners.forEach((listener) => listener());
  };
  return Object.freeze({
    getState: () => state,
    setOnline(value: boolean) {
      if (!value) publish({ status: "offline" });
      else if (state.status === "offline") publish({ status: "restored" });
    },
    dismissRestored() {
      if (state.status === "restored") publish({ status: "online" });
    },
    dispose() {
      stopped = true;
      listeners.clear();
      state = { status: "online" };
    },
    subscribe(listener: () => void) {
      if (stopped) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
