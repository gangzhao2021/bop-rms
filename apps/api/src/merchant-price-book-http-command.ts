import { readClosedRecord } from "@bop/identity";
import { PriceBookWorkflowError, type PriceBookAction } from "@rms/pricing";
import type { createMerchantPriceBookCommands } from "./merchant-price-book-commands.js";

export function createMerchantPriceBookHttpCommand(
  commands: Pick<ReturnType<typeof createMerchantPriceBookCommands>, "executeTransport">,
) {
  return async (request: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    let raw: Record<string, unknown>;
    try {
      raw = readClosedRecord(request.command, [
        "action",
        "operationReference",
        "priceBookReference",
        "expectedAggregateVersion",
        "stableCode",
        "entries",
      ]);
    } catch {
      throw new PriceBookWorkflowError("PRICE_BOOK_INPUT_INVALID");
    }
    const { action, ...input } = raw;
    if (
      typeof action !== "string" ||
      !["CreateDraft", "ReplaceDraft", "Publish", "Archive"].includes(action)
    )
      throw new PriceBookWorkflowError("PRICE_BOOK_INPUT_INVALID");
    const result = await commands.executeTransport({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
      action: action as PriceBookAction,
      input,
    });
    return {
      status: result.status,
      priceBookReference: result.aggregate.priceBookReference,
      versionReference: result.aggregate.versionReference,
      aggregateVersion: result.aggregate.aggregateVersion,
      lifecycle: result.aggregate.lifecycle,
      snapshotDigest: result.aggregate.snapshotDigest,
    };
  };
}
