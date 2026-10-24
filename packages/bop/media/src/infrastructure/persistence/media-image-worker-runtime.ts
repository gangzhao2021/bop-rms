import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";
import { parseMediaInstant, parseMediaReferenceId } from "../../contracts/media.js";
import {
  parseMediaImagePromotionDestination,
  type MediaImagePromotionPlan,
} from "../processing/media-image-promotion.js";
import {
  parseS3QuarantineImageConfig,
  type S3QuarantineImageConfig,
} from "../provider/s3-quarantine-image-source.js";
import {
  createSqsImageScanIngress,
  parseSqsImageScanIngressConfig,
  type SqsImageScanIngressConfig,
} from "../provider/sqs-image-scan-ingress.js";
import {
  createPostgresMediaImageScanAdmissionStore,
  type MediaImageScanAdmissionStoreOptions,
} from "./media-image-scan-admission-store.js";
import { createMediaImageProcessingRuntime } from "./media-image-processing-store.js";

export interface MediaImageWorkerConfiguration {
  readonly profile: "MEDIA_IMAGE_WORKER_V1";
  readonly workloadReference: string;
  readonly quarantineConfig: S3QuarantineImageConfig;
  readonly destination: MediaImagePromotionPlan["destination"];
  readonly ingress: SqsImageScanIngressConfig;
}
export interface MediaImageWorkerRuntimeOptions {
  readonly config: MediaImageWorkerConfiguration;
  readonly transactions: MediaImageScanAdmissionStoreOptions["transactions"];
  readonly registerBeforeCommit: MediaImageScanAdmissionStoreOptions["registerBeforeCommit"];
  readonly clock: { now(): string };
  /** Private infrastructure seams only; absent on the public Worker entry. */
  readonly ingressSdk?: Parameters<typeof createSqsImageScanIngress>[0]["sdk"];
  readonly storageSdk?: Parameters<typeof createMediaImageProcessingRuntime>[0]["sdk"];
}
const fail = (): never => {
  throw Object.assign(new Error("Media image worker is unavailable"), {
    code: "MEDIA_IMAGE_WORKER_UNAVAILABLE",
  });
};
function closed(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[key] = d.value;
  }
  return r;
}
export function parseMediaImageWorkerConfiguration(value: unknown): MediaImageWorkerConfiguration {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [
        "profile",
        "workloadReference",
        "quarantineConfig",
        "destination",
        "ingress",
      ]),
      quarantineConfig = parseS3QuarantineImageConfig(r.quarantineConfig),
      destination = parseMediaImagePromotionDestination(r.destination),
      ingress = parseSqsImageScanIngressConfig(r.ingress);
    if (
      r.profile !== "MEDIA_IMAGE_WORKER_V1" ||
      destination.accountId !== quarantineConfig.accountId ||
      ingress.accountId !== quarantineConfig.accountId ||
      ingress.quarantineBucket !== quarantineConfig.bucket ||
      ingress.protectionPlanArn !== quarantineConfig.protectionPlanArn ||
      (destination.bucket === quarantineConfig.bucket &&
        (destination.cleanPrefix.startsWith(quarantineConfig.quarantinePrefix) ||
          quarantineConfig.quarantinePrefix.startsWith(destination.cleanPrefix)))
    )
      return fail();
    return Object.freeze({
      profile: "MEDIA_IMAGE_WORKER_V1",
      workloadReference: parseMediaReferenceId(r.workloadReference),
      quarantineConfig,
      destination,
      ingress,
    });
  } catch {
    return fail();
  }
}
/** The separate audited Permission provisioner must bind this exact complete
 * deployment configuration. Calculating a digest does not grant authority. */
export function mediaImageWorkerConfigurationDigest(value: MediaImageWorkerConfiguration): string {
  return "sha256:" + sha256Hex(canonicalizeRfc8785(parseMediaImageWorkerConfiguration(value)));
}

/** SDK delivery -> owning admission -> durable plan -> real image processing ->
 * atomic completion -> current message acknowledgement. No caller event input. */
export function createMediaImageWorkerRuntime(options: MediaImageWorkerRuntimeOptions) {
  const r = closed(options, [
      "config",
      "transactions",
      "registerBeforeCommit",
      "clock",
      ...(Object.hasOwn(options, "ingressSdk") ? ["ingressSdk"] : []),
      ...(Object.hasOwn(options, "storageSdk") ? ["storageSdk"] : []),
    ]),
    config = parseMediaImageWorkerConfiguration(r.config),
    deploymentConfigurationDigest = mediaImageWorkerConfigurationDigest(config),
    suppliedClock = closed(r.clock, ["now"]);
  if (typeof suppliedClock.now !== "function") return fail();
  const rawNow = (suppliedClock.now as () => string).bind(r.clock);
  let active: AbortController | undefined,
    stopped = false,
    latest = "";
  const clock = {
    now() {
      if (stopped || active?.signal.aborted) return fail();
      const at = parseMediaInstant(rawNow());
      if (at < latest) {
        active?.abort();
        return fail();
      }
      latest = at;
      return at;
    },
  };
  const ingress = createSqsImageScanIngress({
    config: config.ingress,
    deploymentConfigurationDigest,
    clock,
    ...(options.ingressSdk === undefined ? {} : { sdk: options.ingressSdk }),
  });
  let admission: ReturnType<typeof createPostgresMediaImageScanAdmissionStore>,
    processing: ReturnType<typeof createMediaImageProcessingRuntime>;
  try {
    admission = createPostgresMediaImageScanAdmissionStore({
      tenantReference: config.quarantineConfig.tenantReference,
      scope: config.quarantineConfig.scope,
      workloadReference: config.workloadReference,
      deploymentConfigurationDigest,
      quarantineConfig: config.quarantineConfig,
      clock,
      transactions: options.transactions,
      registerBeforeCommit: options.registerBeforeCommit,
    });
    processing = createMediaImageProcessingRuntime({
      tenantReference: config.quarantineConfig.tenantReference,
      scope: config.quarantineConfig.scope,
      systemActorReference: config.workloadReference,
      clock,
      transactions: options.transactions,
      registerBeforeCommit: options.registerBeforeCommit,
      authority: admission.authority,
      quarantineConfig: config.quarantineConfig,
      destination: config.destination,
      ...(options.storageSdk === undefined ? {} : { sdk: options.storageSdk }),
    });
  } catch (error) {
    try {
      ingress.close();
    } catch {
      // Cleanup cannot replace the original construction failure.
    }
    throw error;
  }
  return Object.freeze({
    async processNext(signal?: AbortSignal): Promise<0 | 1> {
      if (
        stopped ||
        active ||
        (signal !== undefined && !(signal instanceof AbortSignal)) ||
        signal?.aborted
      )
        return fail();
      const controller = new AbortController(),
        abort = () => controller.abort();
      active = controller;
      signal?.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(abort, 240000);
      try {
        clock.now();
        const message = await ingress.receive(controller.signal);
        clock.now();
        if (message === null) return 0;
        const request = await admission.admit(message.delivery);
        clock.now();
        await processing.process(request, controller.signal);
        clock.now();
        // A thrown/unknown commit never reaches acknowledgement. Re-delivery
        // recovers the same admission, plan and completion before any S3 work.
        await message.acknowledge(controller.signal);
        clock.now();
        return 1;
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        active = undefined;
      }
    },
    close() {
      if (stopped) return;
      stopped = true;
      active?.abort();
      try {
        ingress.close();
      } finally {
        processing.close();
      }
    },
  });
}
