import { describe, expect, it } from "vitest";
import type { StructuredLogDestination } from "@bop-rms/observability";
import { createApiRuntimeLogger } from "./server.js";

describe("WP-0040 API composition-root logging", () => {
  it("uses centralized JSON configuration and the API event allowlist", () => {
    const records: string[] = [];
    const destination: StructuredLogDestination = {
      write: (message) => records.push(String(message)),
    };
    const logger = createApiRuntimeLogger(destination);

    logger.info({ event: "listening", port: 3100, resultCode: "SUCCESS" });

    expect(JSON.parse(records.join(""))).toMatchObject({
      environment: "test",
      event: "listening",
      module: "api-runtime",
      port: 3100,
      resultCode: "SUCCESS",
      service: "bop-rms-api",
    });
  });
});
