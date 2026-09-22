import { createPostgresDiningCheckoutExpiryCandidates } from "@rms/ordering";
import { createDiningCheckoutExpiryRecorder } from "./dining-checkout-expiry-recorder.js";

/** Discovery commits before recording, so no scan transaction holds locks while
 * the recorder acquires Payment fences. Repeated scans preserve unknown outcomes.
 */
export function createDiningCheckoutExpiryDispatcher(
  options: Parameters<typeof createDiningCheckoutExpiryRecorder>[0] & {
    pageSize: number;
    authorizeDiscovery: Parameters<
      typeof createPostgresDiningCheckoutExpiryCandidates
    >[0]["authorize"];
  },
) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new TypeError("DINING_CHECKOUT_EXPIRY_DISPATCHER_CONFIG_INVALID");
  const source = createPostgresDiningCheckoutExpiryCandidates({
    brandReference: options.scope.brandReference,
    storeReference: options.scope.storeReference,
    authorize: options.authorizeDiscovery,
  });
  const recorder = createDiningCheckoutExpiryRecorder(options);
  let cursor: string | null = null,
    stopping = false;
  let inFlight: Promise<number> | undefined;
  const execute = async () => {
    const page = await options.transactions.run((tx) =>
      source.discover(tx, { observedAt: options.now(), after: cursor, limit: options.pageSize }),
    );
    let processed = 0;
    for (const candidate of page) {
      if (stopping) break;
      const result = await recorder.record(candidate);
      if (
        result.status !== "Created" &&
        result.status !== "Existing" &&
        result.status !== "NotDue" &&
        result.status !== "NotStarted"
      )
        throw new Error("DINING_CHECKOUT_EXPIRY_DISPATCH_FAILED");
      processed++;
    }
    if (!stopping)
      cursor = page.length === options.pageSize ? (page.at(-1)?.orderBatchReference ?? null) : null;
    return processed;
  };
  return Object.freeze({
    runOnce(): Promise<number> {
      if (stopping) return Promise.resolve(0);
      if (inFlight) return inFlight;
      inFlight = execute().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    async stop() {
      stopping = true;
      await inFlight?.catch(() => undefined);
      return "drained" as const;
    },
  });
}
