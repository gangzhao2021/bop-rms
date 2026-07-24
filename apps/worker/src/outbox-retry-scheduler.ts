import type { DeliveryDecisionResult } from "@bop/eventing";
import type { AuthorizedDispatchScope } from "./outbox-dispatcher.js";

export interface ParkedOutboxRetryPort {
  schedule(
    scope: AuthorizedDispatchScope,
    input: { readonly batchSize: number },
  ): Promise<readonly DeliveryDecisionResult[]>;
}

export class OutboxRetryScheduler {
  #cursor = 0;

  constructor(
    private readonly dependencies: {
      readonly retries: ParkedOutboxRetryPort;
      readonly scopes: readonly AuthorizedDispatchScope[];
    },
  ) {
    if (dependencies.scopes.length === 0) throw new TypeError("at least one scope is required");
  }

  async runOnce(): Promise<number> {
    let remaining = 100;
    let handled = 0;
    for (let offset = 0; offset < this.dependencies.scopes.length && remaining > 0; offset += 1) {
      const scope =
        this.dependencies.scopes[(this.#cursor + offset) % this.dependencies.scopes.length];
      if (!scope) continue;
      const results = await this.dependencies.retries.schedule(scope, {
        batchSize: Math.min(25, remaining),
      });
      handled += results.length;
      remaining -= results.length;
    }
    this.#cursor = (this.#cursor + 1) % this.dependencies.scopes.length;
    return handled;
  }
}
