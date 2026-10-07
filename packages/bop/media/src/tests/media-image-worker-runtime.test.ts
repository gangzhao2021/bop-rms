import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMediaImageWorkerRuntime,
  mediaImageWorkerConfigurationDigest,
  parseMediaImageWorkerConfiguration,
  type MediaImageWorkerConfiguration,
} from "../infrastructure/persistence/media-image-worker-runtime.js";
import { createMediaImageWorker } from "../worker.js";

const owners = vi.hoisted(() => ({
  receive: vi.fn(),
  ingressClose: vi.fn(),
  admit: vi.fn(),
  process: vi.fn(),
  processingClose: vi.fn(),
  ingressFactory: vi.fn(),
  admissionFactory: vi.fn(),
  processingFactory: vi.fn(),
}));
vi.mock("../infrastructure/provider/sqs-image-scan-ingress.js", () => ({
  parseSqsImageScanIngressConfig: (input: unknown) => input,
  createSqsImageScanIngress: (input: unknown) => {
    owners.ingressFactory(input);
    return { receive: owners.receive, close: owners.ingressClose };
  },
}));
vi.mock("../infrastructure/persistence/media-image-scan-admission-store.js", () => ({
  createPostgresMediaImageScanAdmissionStore: (input: unknown) => {
    owners.admissionFactory(input);
    return { admit: owners.admit, authority: Object.freeze({}) };
  },
}));
vi.mock("../infrastructure/persistence/media-image-processing-store.js", () => ({
  createMediaImageProcessingRuntime: (input: unknown) => {
    owners.processingFactory(input);
    return { process: owners.process, close: owners.processingClose };
  },
}));
const id = (n: number) => `019a2421-0021-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-02T12:00:00.000Z",
  account = "111122223333",
  key = `arn:aws:kms:ca-central-1:${account}:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
  plan = `arn:aws:guardduty:ca-central-1:${account}:malware-protection-plan/synthetic123`;
function fixture() {
  // Orchestration only: transport authentication, admission persistence and
  // processing are covered by their real owner/native tests, not these doubles.
  const config = {
    profile: "MEDIA_IMAGE_WORKER_V1",
    workloadReference: id(4),
    quarantineConfig: {
      tenantReference: id(1),
      scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
      region: "ca-central-1",
      accountId: account,
      bucket: "synthetic-quarantine",
      quarantinePrefix: "quarantine/",
      kmsKeyArn: key,
      protectionPlanArn: plan,
    },
    destination: {
      accountId: account,
      bucket: "synthetic-clean",
      cleanPrefix: "clean/",
      kmsKeyArn: key,
    },
    ingress: {
      accountId: account,
      quarantineBucket: "synthetic-quarantine",
      protectionPlanArn: plan,
    },
  } as MediaImageWorkerConfiguration;
  const state = { now: at },
    options = {
      config,
      clock: { now: () => state.now },
      transactions: { run: vi.fn() },
      registerBeforeCommit: vi.fn(),
    },
    worker = createMediaImageWorkerRuntime(options),
    delivery = {
      scanEvent: { id: "controlled-event" },
      transport: { profile: "controlled-private-seam" },
    },
    request = {
      admissionReference: id(5),
      sourceAssetVersionReference: id(6),
      scanEvent: delivery.scanEvent,
      correlationId: id(7),
    },
    acknowledge = vi.fn(async () => undefined);
  owners.receive.mockResolvedValue({ delivery, acknowledge });
  owners.admit.mockResolvedValue(request);
  owners.process.mockResolvedValue({});
  return { worker, config, options, delivery, request, acknowledge, state };
}
beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(owners)) fn.mockReset();
});
afterEach(() => vi.useRealTimers());
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected an actual captured owner call");
  return value;
}

it("receives internally and acknowledges only after owning admission and completion return", async () => {
  const h = fixture();
  expect(await h.worker.processNext()).toBe(1);
  expect(owners.admit).toHaveBeenCalledWith(h.delivery);
  expect(owners.process).toHaveBeenCalledWith(h.request, expect.any(AbortSignal));
  expect(owners.receive.mock.invocationCallOrder[0]).toBeLessThan(
    required(owners.admit.mock.invocationCallOrder[0]),
  );
  expect(owners.admit.mock.invocationCallOrder[0]).toBeLessThan(
    required(owners.process.mock.invocationCallOrder[0]),
  );
  expect(owners.process.mock.invocationCallOrder[0]).toBeLessThan(
    required(h.acknowledge.mock.invocationCallOrder[0]),
  );
  const digest = mediaImageWorkerConfigurationDigest(h.config);
  expect(owners.ingressFactory).toHaveBeenCalledWith(
    expect.objectContaining({ deploymentConfigurationDigest: digest }),
  );
  expect(owners.admissionFactory).toHaveBeenCalledWith(
    expect.objectContaining({ deploymentConfigurationDigest: digest, workloadReference: id(4) }),
  );
});
it("does no owning work for an empty receive", async () => {
  const h = fixture();
  owners.receive.mockResolvedValue(null);
  expect(await h.worker.processNext()).toBe(0);
  expect(owners.admit).not.toHaveBeenCalled();
  expect(owners.process).not.toHaveBeenCalled();
  expect(h.acknowledge).not.toHaveBeenCalled();
});
it.each(["admit", "process"] as const)("never confirms a failed or uncertain %s", async (stage) => {
  const h = fixture(),
    error = Object.assign(new Error("controlled uncertain commit"), {
      code: "COMMIT_OUTCOME_UNKNOWN",
    });
  owners[stage].mockRejectedValue(error);
  await expect(h.worker.processNext()).rejects.toBe(error);
  expect(h.acknowledge).not.toHaveBeenCalled();
});
it("does not issue another completion when only acknowledgement fails", async () => {
  const h = fixture();
  h.acknowledge.mockRejectedValueOnce(new Error("controlled lost ack"));
  await expect(h.worker.processNext()).rejects.toThrow("controlled lost ack");
  expect(owners.process).toHaveBeenCalledTimes(1);
  expect(h.acknowledge).toHaveBeenCalledTimes(1);
});
it("retains cancellation through database guards and refuses acknowledgement after cancellation", async () => {
  const h = fixture(),
    parent = new AbortController();
  owners.process.mockImplementation(async () => {
    parent.abort();
    const captured = required(owners.admissionFactory.mock.calls[0])[0] as {
      clock: { now(): string };
    };
    expect(() => captured.clock.now()).toThrow("Media image worker is unavailable");
    return {};
  });
  await expect(h.worker.processNext(parent.signal)).rejects.toThrow(
    "Media image worker is unavailable",
  );
  expect(h.acknowledge).not.toHaveBeenCalled();
});
it("rejects concurrent work and closes both owned clients even if one cleanup fails", async () => {
  const h = fixture();
  let finish!: (value: null) => void;
  owners.receive.mockImplementation(
    () =>
      new Promise<null>((resolve) => {
        finish = resolve;
      }),
  );
  const first = h.worker.processNext();
  await expect(h.worker.processNext()).rejects.toThrow("Media image worker is unavailable");
  owners.ingressClose.mockImplementation(() => {
    throw new Error("controlled cleanup failure");
  });
  expect(() => h.worker.close()).toThrow("controlled cleanup failure");
  expect(owners.processingClose).toHaveBeenCalledTimes(1);
  finish(null);
  await expect(first).rejects.toThrow("Media image worker is unavailable");
  await expect(h.worker.processNext()).rejects.toThrow("Media image worker is unavailable");
});
it.each(["admissionFactory", "processingFactory"] as const)(
  "closes acquired ingress after %s construction fails and preserves that error",
  (stage) => {
    const h = fixture(),
      constructionError = new Error("controlled construction failure");
    owners[stage].mockImplementation(() => {
      throw constructionError;
    });
    owners.ingressClose.mockImplementation(() => {
      throw new Error("controlled cleanup failure");
    });
    let caught: unknown;
    try {
      createMediaImageWorkerRuntime(h.options);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(constructionError);
    expect(owners.ingressClose).toHaveBeenCalledTimes(1);
    expect(owners.processingClose).not.toHaveBeenCalled();
    expect(h.options.transactions.run).not.toHaveBeenCalled();
  },
);
it("binds source/destination/ingress account and object protection configuration before creating ports", () => {
  const h = fixture();
  for (const config of [
    { ...h.config, ingress: { ...h.config.ingress, accountId: "999988887777" } },
    { ...h.config, ingress: { ...h.config.ingress, quarantineBucket: "other-bucket" } },
    { ...h.config, ingress: { ...h.config.ingress, protectionPlanArn: plan + "other" } },
    { ...h.config, destination: { ...h.config.destination, accountId: "999988887777" } },
    {
      ...h.config,
      destination: {
        ...h.config.destination,
        bucket: h.config.quarantineConfig.bucket,
        cleanPrefix: "quarantine/",
      },
    },
  ])
    expect(() => parseMediaImageWorkerConfiguration(config)).toThrow(
      "Media image worker is unavailable",
    );
});
it("keeps SDK, clock and event injection outside the public server entry", () => {
  const h = fixture();
  for (const extra of [{ ingressSdk: {} }, { storageSdk: {} }, { clock: {} }, { event: {} }]) {
    expect(() =>
      createMediaImageWorker({
        config: h.config,
        transactions: h.options.transactions,
        registerBeforeCommit: h.options.registerBeforeCommit,
        ...extra,
      }),
    ).toThrow("MEDIA_IMAGE_WORKER_CONFIGURATION_INVALID");
  }
});
