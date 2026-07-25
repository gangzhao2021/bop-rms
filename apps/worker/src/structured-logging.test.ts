import { describe, expect, it } from "vitest";
import type { StructuredLogDestination } from "@bop-rms/observability";
import { createWorkerRuntimeLogger } from "./index.js";

describe("WP-0040 Worker composition-root logging", () => {
  it("uses centralized JSON configuration and the Worker event allowlist", () => {
    const records: string[] = [];
    const destination: StructuredLogDestination = {
      write: (message) => records.push(String(message)),
    };
    const logger = createWorkerRuntimeLogger(destination);

    logger.info({ event: "worker_started", resultCode: "SUCCESS" });

    expect(JSON.parse(records.join(""))).toMatchObject({
      environment: "test",
      event: "worker_started",
      module: "worker-runtime",
      resultCode: "SUCCESS",
      service: "bop-rms-worker",
    });
  });
});
