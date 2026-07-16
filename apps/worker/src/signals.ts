import type { EventEmitter } from "node:events";
export type ShutdownSignal = "SIGINT" | "SIGTERM";
export function installSignalHandlers(
  emitter: EventEmitter,
  shutdown: (signal: ShutdownSignal) => void | Promise<void>,
) {
  const handlers = new Map<ShutdownSignal, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    emitter.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) emitter.off(signal, handler);
  };
}
