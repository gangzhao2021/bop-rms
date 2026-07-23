import type {
  ClaimedOutboxEvent,
  OutboxCompletionResult,
  OutboxDispatchErrorCode,
  OutboxTransportAdapter,
} from "@bop/eventing";

export interface AuthorizedDispatchScope {
  readonly brandId: string;
  readonly storeId?: string;
}

export interface OutboxDispatchPort {
  claim(
    scope: AuthorizedDispatchScope,
    input: {
      readonly batchSize: number;
      readonly leaseDurationSeconds: number;
      readonly leaseOwner: string;
      readonly leaseToken: string;
    },
  ): Promise<readonly ClaimedOutboxEvent[]>;
  complete(
    scope: AuthorizedDispatchScope,
    input: { readonly eventId: string; readonly leaseToken: string },
  ): Promise<OutboxCompletionResult>;
  fail(
    scope: AuthorizedDispatchScope,
    input: {
      readonly errorCode: OutboxDispatchErrorCode;
      readonly eventId: string;
      readonly leaseToken: string;
    },
  ): Promise<OutboxCompletionResult>;
}

export interface OutboxDispatcherConfig {
  readonly adapterConcurrency: number;
  readonly adapterTimeoutMs: number;
  readonly batchMaximum: number;
  readonly drainDeadlineMs: number;
  readonly leaseDurationSeconds: number;
  readonly perScopeMaximum: number;
}

export const defaultOutboxDispatcherConfig: OutboxDispatcherConfig = {
  adapterConcurrency: 10,
  adapterTimeoutMs: 20_000,
  batchMaximum: 100,
  drainDeadlineMs: 25_000,
  leaseDurationSeconds: 30,
  perScopeMaximum: 25,
};

export interface OutboxDispatchTelemetry {
  record(
    event:
      | {
          readonly operation: "claim";
          readonly result: "empty" | "success";
          readonly count: number;
        }
      | {
          readonly operation: "publish";
          readonly result: "acknowledged" | "failed" | "lost_lease";
          readonly errorCode?: OutboxDispatchErrorCode;
        },
  ): void;
}

const noopTelemetry: OutboxDispatchTelemetry = { record: () => undefined };

function validateConfig(config: OutboxDispatcherConfig): void {
  const bounds: readonly (readonly [keyof OutboxDispatcherConfig, number])[] = [
    ["adapterConcurrency", 100],
    ["adapterTimeoutMs", 29_000],
    ["batchMaximum", 100],
    ["drainDeadlineMs", 25_000],
    ["leaseDurationSeconds", 300],
    ["perScopeMaximum", 100],
  ];
  for (const [key, maximum] of bounds) {
    const value = config[key];
    if (!Number.isInteger(value) || value < 1 || value > maximum)
      throw new TypeError(`${key} must be an integer between 1 and ${maximum}`);
  }
  if (config.perScopeMaximum > config.batchMaximum)
    throw new TypeError("perScopeMaximum cannot exceed batchMaximum");
  if (config.adapterTimeoutMs >= config.leaseDurationSeconds * 1_000)
    throw new TypeError("adapterTimeoutMs must be shorter than the lease");
}

function transportFailure(errorCode: OutboxDispatchErrorCode) {
  return { status: "failed" as const, errorCode };
}

export class OutboxDispatcher {
  readonly #active = new Set<Promise<void>>();
  readonly #config: OutboxDispatcherConfig;
  #cursor = 0;
  #stopping = false;

  constructor(
    private readonly dependencies: {
      readonly adapter: OutboxTransportAdapter;
      readonly dispatch: OutboxDispatchPort;
      readonly leaseOwner: string;
      readonly newLeaseToken: () => string;
      readonly scopes: readonly AuthorizedDispatchScope[];
      readonly telemetry?: OutboxDispatchTelemetry;
    },
    config: Partial<OutboxDispatcherConfig> = {},
  ) {
    this.#config = { ...defaultOutboxDispatcherConfig, ...config };
    validateConfig(this.#config);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(dependencies.leaseOwner))
      throw new TypeError("leaseOwner must be an opaque safe identifier");
    if (dependencies.scopes.length === 0) throw new TypeError("at least one scope is required");
  }

  get inFlight(): number {
    return this.#active.size;
  }

  async runOnce(): Promise<number> {
    if (this.#stopping) return 0;
    const { scopes } = this.dependencies;
    let remaining = this.#config.batchMaximum;
    let claimedCount = 0;
    for (let offset = 0; offset < scopes.length && remaining > 0 && !this.#stopping; offset += 1) {
      const scope = scopes[(this.#cursor + offset) % scopes.length];
      if (!scope) continue;
      const batchSize = Math.min(this.#config.perScopeMaximum, remaining);
      const claimed = await this.dependencies.dispatch.claim(scope, {
        batchSize,
        leaseDurationSeconds: this.#config.leaseDurationSeconds,
        leaseOwner: this.dependencies.leaseOwner,
        leaseToken: this.dependencies.newLeaseToken(),
      });
      this.telemetry.record({
        operation: "claim",
        result: claimed.length === 0 ? "empty" : "success",
        count: claimed.length,
      });
      remaining -= claimed.length;
      claimedCount += claimed.length;
      await this.#dispatchWithConcurrency(scope, claimed);
    }
    this.#cursor = (this.#cursor + 1) % scopes.length;
    return claimedCount;
  }

  async stop(): Promise<"drained" | "deadline_exceeded"> {
    this.#stopping = true;
    if (this.#active.size === 0) return "drained";
    const drained = Promise.allSettled([...this.#active]).then(() => "drained" as const);
    const deadline = new Promise<"deadline_exceeded">((resolve) => {
      const timer = setTimeout(() => resolve("deadline_exceeded"), this.#config.drainDeadlineMs);
      timer.unref();
    });
    return await Promise.race([drained, deadline]);
  }

  get telemetry(): OutboxDispatchTelemetry {
    return this.dependencies.telemetry ?? noopTelemetry;
  }

  async #dispatchWithConcurrency(
    scope: AuthorizedDispatchScope,
    claimed: readonly ClaimedOutboxEvent[],
  ): Promise<void> {
    const batchTasks: Promise<void>[] = [];
    for (const item of claimed) {
      while (this.#active.size >= this.#config.adapterConcurrency)
        await Promise.race([...this.#active].map((task) => task.catch(() => undefined)));
      const task = this.#publishOne(scope, item);
      batchTasks.push(task);
      this.#active.add(task);
      void task.then(
        () => this.#active.delete(task),
        () => this.#active.delete(task),
      );
    }
    const results = await Promise.allSettled(batchTasks);
    if (results.some((result) => result.status === "rejected"))
      throw new Error("OUTBOX_DISPATCH_PERSISTENCE_FAILED");
  }

  async #publishOne(scope: AuthorizedDispatchScope, claimed: ClaimedOutboxEvent): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ReturnType<typeof transportFailure>>((resolve) => {
      timer = setTimeout(
        () => resolve(transportFailure("TRANSPORT_TIMEOUT")),
        this.#config.adapterTimeoutMs,
      );
      timer.unref();
    });
    let result;
    try {
      result = await Promise.race([
        this.dependencies.adapter.publish(claimed.envelope, {
          attemptCount: claimed.attemptCount,
        }),
        timeout,
      ]);
    } catch {
      result = transportFailure("TRANSPORT_UNAVAILABLE");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result.status === "acknowledged") {
      const completion = await this.dependencies.dispatch.complete(scope, {
        eventId: claimed.envelope.eventId,
        leaseToken: claimed.leaseToken,
      });
      this.telemetry.record({
        operation: "publish",
        result: completion === "completed" ? "acknowledged" : "lost_lease",
      });
      return;
    }
    const completion = await this.dependencies.dispatch.fail(scope, {
      errorCode: result.errorCode,
      eventId: claimed.envelope.eventId,
      leaseToken: claimed.leaseToken,
    });
    this.telemetry.record({
      operation: "publish",
      result: completion === "completed" ? "failed" : "lost_lease",
      ...(completion === "completed" ? { errorCode: result.errorCode } : {}),
    });
  }
}
