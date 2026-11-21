import { afterEach, expect, it, vi } from "vitest";
import { refreshInternalOrderReceiptObservations as refresh } from "./pilot-receipt-observations.mjs";
afterEach(() => vi.unstubAllEnvs());
it.each(["production", "expired", "denied"])(
  "does not open a source or Provider for %s",
  async (reason) => {
    vi.stubEnv("NODE_ENV", reason === "production" ? "production" : "development");
    const run = vi.fn(),
      createSimulatedProvider = vi.fn(),
      authorize = vi.fn(async () => reason !== "denied");
    const now = "2026-09-21T00:00:00.000Z";
    const resources = {
      now: () => now,
      publicProfile: {
        binding: { validUntil: reason === "expired" ? now : "2026-09-22T00:00:00.000Z" },
      },
      transactions: { run },
    };
    await expect(
      refresh(resources, "synthetic-order", authorize, {
        providerAccountReference: "synthetic-account",
        createSimulatedProvider,
      }),
    ).rejects.toThrow("INTERNAL_RECEIPT_SCOPE_DENIED");
    expect(run).not.toHaveBeenCalled();
    expect(createSimulatedProvider).not.toHaveBeenCalled();
  },
);
