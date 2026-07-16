export type WorkerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
export interface LifecycleHooks {
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}
export class WorkerLifecycle {
  #state: WorkerState = "idle";
  #stopPromise?: Promise<void>;
  constructor(private readonly hooks: LifecycleHooks = {}) {}
  get state() {
    return this.#state;
  }
  async start() {
    if (this.#state !== "idle") throw new Error(`worker cannot start from ${this.#state}`);
    this.#state = "starting";
    try {
      await this.hooks.onStart?.();
      this.#state = "running";
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }
  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#state === "idle" || this.#state === "stopped") {
      this.#state = "stopped";
      return Promise.resolve();
    }
    this.#state = "stopping";
    this.#stopPromise = (async () => {
      try {
        await this.hooks.onStop?.();
        this.#state = "stopped";
      } catch (error) {
        this.#state = "failed";
        throw error;
      }
    })();
    return this.#stopPromise;
  }
}
