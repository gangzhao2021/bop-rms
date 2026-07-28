export type DependencyReadinessStatus = "not_configured" | "not_ready" | "ready" | "timeout";

export type ReadinessProbe = () => Promise<"not_ready" | "ready"> | "not_ready" | "ready";

export interface HealthReadinessOptions {
  databaseProbe?: ReadinessProbe;
  negativeCacheMilliseconds?: number;
  now?: () => string;
  nowMilliseconds?: () => number;
  positiveCacheMilliseconds?: number;
  probeTimeoutMilliseconds?: number;
}

interface CachedProbeResult {
  expiresAt: number;
  status: Exclude<DependencyReadinessStatus, "not_configured">;
}

export interface HealthSnapshot {
  checkedAt: string;
  service: "bop-rms-api";
  status: "healthy";
}

export interface ReadinessSnapshot {
  checkedAt: string;
  dependencies: {
    database: {
      required: true;
      status: DependencyReadinessStatus;
    };
  };
  service: "bop-rms-api";
  status: "not_ready" | "ready";
}

type LifecycleState = "accepting" | "draining" | "starting";

const service = "bop-rms-api" as const;

function requireBoundedMilliseconds(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum)
    throw new Error(`${name} must be an integer from 0 to ${maximum}`);
  return value;
}

export class HealthReadinessController {
  readonly #databaseProbe: ReadinessProbe | undefined;
  readonly #negativeCacheMilliseconds: number;
  readonly #now: () => string;
  readonly #nowMilliseconds: () => number;
  readonly #positiveCacheMilliseconds: number;
  readonly #probeTimeoutMilliseconds: number;
  #cachedProbeResult: CachedProbeResult | undefined;
  #inFlightProbe: Promise<Exclude<DependencyReadinessStatus, "not_configured">> | undefined;
  #lifecycleState: LifecycleState = "starting";
  #ownedTimers = 0;

  constructor({
    databaseProbe,
    negativeCacheMilliseconds = 250,
    now = () => new Date().toISOString(),
    nowMilliseconds = Date.now,
    positiveCacheMilliseconds = 1_000,
    probeTimeoutMilliseconds = 1_000,
  }: HealthReadinessOptions = {}) {
    this.#databaseProbe = databaseProbe;
    this.#negativeCacheMilliseconds = requireBoundedMilliseconds(
      negativeCacheMilliseconds,
      "negativeCacheMilliseconds",
      250,
    );
    this.#now = now;
    this.#nowMilliseconds = nowMilliseconds;
    this.#positiveCacheMilliseconds = requireBoundedMilliseconds(
      positiveCacheMilliseconds,
      "positiveCacheMilliseconds",
      1_000,
    );
    this.#probeTimeoutMilliseconds = requireBoundedMilliseconds(
      probeTimeoutMilliseconds,
      "probeTimeoutMilliseconds",
      1_000,
    );
  }

  beginDrain(): void {
    if (this.#lifecycleState === "draining") return;
    this.#lifecycleState = "draining";
    this.#cachedProbeResult = undefined;
  }

  completeStartup(): void {
    if (this.#lifecycleState === "starting") this.#lifecycleState = "accepting";
  }

  healthSnapshot(): HealthSnapshot {
    return {
      checkedAt: this.#now(),
      service,
      status: "healthy",
    };
  }

  async readinessSnapshot(): Promise<ReadinessSnapshot> {
    let databaseStatus: DependencyReadinessStatus =
      this.#databaseProbe === undefined ? "not_configured" : "not_ready";

    if (this.#lifecycleState === "accepting" && this.#databaseProbe !== undefined)
      databaseStatus = await this.#databaseReadiness();

    const ready = this.#lifecycleState === "accepting" && databaseStatus === "ready";
    return {
      checkedAt: this.#now(),
      dependencies: {
        database: {
          required: true,
          status: databaseStatus,
        },
      },
      service,
      status: ready ? "ready" : "not_ready",
    };
  }

  resourceSnapshot(): {
    cachedStatus: DependencyReadinessStatus | undefined;
    lifecycleState: LifecycleState;
    ownedTimers: number;
    probeInFlight: boolean;
  } {
    return {
      cachedStatus: this.#cachedProbeResult?.status,
      lifecycleState: this.#lifecycleState,
      ownedTimers: this.#ownedTimers,
      probeInFlight: this.#inFlightProbe !== undefined,
    };
  }

  async #databaseReadiness(): Promise<Exclude<DependencyReadinessStatus, "not_configured">> {
    const cached = this.#cachedProbeResult;
    if (cached !== undefined && this.#nowMilliseconds() < cached.expiresAt) return cached.status;

    if (this.#inFlightProbe !== undefined) return this.#inFlightProbe;

    const probe = this.#runDatabaseProbe();
    this.#inFlightProbe = probe;
    void probe.finally(() => {
      if (this.#inFlightProbe === probe) this.#inFlightProbe = undefined;
    });
    return probe;
  }

  async #runDatabaseProbe(): Promise<Exclude<DependencyReadinessStatus, "not_configured">> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        timer = undefined;
        this.#ownedTimers -= 1;
        resolve("timeout");
      }, this.#probeTimeoutMilliseconds);
      this.#ownedTimers += 1;
      timer.unref();
    });
    const probe = Promise.resolve()
      .then(() => this.#databaseProbe?.())
      .then(
        (result): "not_ready" | "ready" => (result === "ready" ? "ready" : "not_ready"),
        (): "not_ready" => "not_ready",
      );

    try {
      const status = await Promise.race([probe, timeout]);
      const cacheMilliseconds =
        status === "ready" ? this.#positiveCacheMilliseconds : this.#negativeCacheMilliseconds;
      if (this.#lifecycleState === "accepting")
        this.#cachedProbeResult = {
          expiresAt: this.#nowMilliseconds() + cacheMilliseconds,
          status,
        };
      return status;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        this.#ownedTimers -= 1;
      }
    }
  }
}
