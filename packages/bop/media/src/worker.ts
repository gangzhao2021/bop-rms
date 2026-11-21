import {
  createMediaImageWorkerRuntime,
  type MediaImageWorkerRuntimeOptions,
} from "./infrastructure/persistence/media-image-worker-runtime.js";

/** Server-only configured Worker entry. No events, SDK doubles, source IDs,
 * admission IDs, signed URLs or object locators are accepted as job input. */
export function createMediaImageWorker(
  options: Pick<MediaImageWorkerRuntimeOptions, "config" | "transactions" | "registerBeforeCommit">,
) {
  if (
    !options ||
    typeof options !== "object" ||
    Reflect.ownKeys(options).length !== 3 ||
    ["config", "transactions", "registerBeforeCommit"].some((key) => {
      const d = Object.getOwnPropertyDescriptor(options, key);
      return !d?.enumerable || !("value" in d);
    })
  )
    throw new Error("MEDIA_IMAGE_WORKER_CONFIGURATION_INVALID");
  return createMediaImageWorkerRuntime({
    config: options.config,
    transactions: options.transactions,
    registerBeforeCommit: options.registerBeforeCommit,
    clock: { now: () => new Date().toISOString() },
  });
}
export {
  parseMediaImageWorkerConfiguration,
  mediaImageWorkerConfigurationDigest,
  type MediaImageWorkerConfiguration,
} from "./infrastructure/persistence/media-image-worker-runtime.js";
