import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  DescribeRuleCommand,
  EventBridgeClient,
  ListTargetsByRuleCommand,
} from "@aws-sdk/client-eventbridge";
import { canonicalizeRfc8785 } from "@bop/audit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFreshSqsImageScanQueue,
  createSqsImageScanIngress,
  parseSqsImageScanIngressConfig,
  type SqsImageScanIngressConfig,
  type SqsImageScanIngressSdk,
} from "../infrastructure/provider/sqs-image-scan-ingress.js";

const at = "2026-10-03T12:00:00.000Z",
  id = "019a2421-0020-7000-8000-000000000001",
  createdTimestamp = String(Date.parse(at) / 1000 - 60),
  unavailable = expect.objectContaining({
    code: "MEDIA_SCAN_INGRESS_UNAVAILABLE",
    message: "Media scan ingress is unavailable",
  }),
  metadata = { httpStatusCode: 200 },
  hash = (value: unknown) =>
    "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(at);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const queueName = "bop-media-scan-" + "a".repeat(64),
    base = {
      region: "ca-central-1" as const,
      accountId: "111122223333",
      kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      workerRoleArn: "arn:aws:iam::111122223333:role/production/media-worker",
      workerRoleId: "AROA" + "A".repeat(17),
      deploymentRoleArn: "arn:aws:iam::111122223333:role/deployment/media-provisioner",
      eventRuleArn: "arn:aws:events:ca-central-1:111122223333:rule/media-clean-scans",
      eventTargetId: "media-scan-queue",
      quarantineBucket: "synthetic-media-quarantine",
      protectionPlanArn:
        "arn:aws:guardduty:ca-central-1:111122223333:malware-protection-plan/synthetic123",
    },
    queueArn = `arn:aws:sqs:ca-central-1:${base.accountId}:${queueName}`,
    queueUrl = `https://sqs.ca-central-1.amazonaws.com/${base.accountId}/${queueName}`;
  const entry = (
    Sid: string,
    Effect: string,
    Principal: unknown,
    Action: unknown,
    Condition?: unknown,
  ) => ({
    Sid,
    Effect,
    Principal,
    Action,
    Resource: queueArn,
    ...(Condition === undefined ? {} : { Condition }),
  });
  const policy = {
    Version: "2012-10-17",
    Statement: [
      entry("ExactGuardDutyRule", "Allow", { Service: "events.amazonaws.com" }, "sqs:SendMessage", {
        ArnEquals: { "aws:SourceArn": base.eventRuleArn },
        StringEquals: { "aws:SourceAccount": base.accountId },
      }),
      entry("DenyOtherSenders", "Deny", "*", "sqs:SendMessage", {
        StringNotEquals: { "aws:PrincipalServiceName": "events.amazonaws.com" },
      }),
      entry("DenyOtherRules", "Deny", "*", "sqs:SendMessage", {
        ArnNotEquals: { "aws:SourceArn": base.eventRuleArn },
      }),
      entry("DenyOtherAccounts", "Deny", "*", "sqs:SendMessage", {
        StringNotEquals: { "aws:SourceAccount": base.accountId },
      }),
      entry("DenyInsecureTransport", "Deny", "*", "sqs:*", {
        Bool: { "aws:SecureTransport": "false" },
      }),
      entry(
        "DenyOtherConsumers",
        "Deny",
        "*",
        ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"],
        { ArnNotEquals: { "aws:PrincipalArn": base.workerRoleArn } },
      ),
      entry(
        "DenyUnprotectedMutation",
        "Deny",
        "*",
        [
          "sqs:SetQueueAttributes",
          "sqs:AddPermission",
          "sqs:RemovePermission",
          "sqs:DeleteQueue",
          "sqs:PurgeQueue",
        ],
        { ArnNotEquals: { "aws:PrincipalArn": base.deploymentRoleArn } },
      ),
      entry("DenyRedrive", "Deny", "*", ["sqs:StartMessageMoveTask", "sqs:CancelMessageMoveTask"]),
    ],
  };
  const pattern = {
    source: ["aws.guardduty"],
    "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
    account: [base.accountId],
    region: [base.region],
    resources: [base.protectionPlanArn],
    detail: {
      schemaVersion: ["1.0"],
      scanStatus: ["COMPLETED"],
      resourceType: ["S3_OBJECT"],
      s3ObjectDetails: { bucketName: [base.quarantineBucket], s3Throttled: [false] },
      scanResultDetails: { scanResultStatus: ["NO_THREATS_FOUND"] },
    },
  };
  const config: SqsImageScanIngressConfig = {
    ...base,
    queueArn,
    queueUrl,
    queueCreatedTimestamp: createdTimestamp,
    origin: {
      profile: "MEDIA_IMAGE_SCAN_QUEUE_ORIGIN_V1",
      operationReference: id,
      queueArn,
      queueUrl,
      queueCreatedTimestamp: createdTimestamp,
      policyDigest: hash(policy),
      createdAt: new Date(Number(createdTimestamp) * 1000 + 1000).toISOString(),
    },
  };
  const event = {
    version: "0",
    id: "synthetic-guardduty-event",
    source: "aws.guardduty",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    account: base.accountId,
    time: at,
    region: base.region,
    resources: [base.protectionPlanArn],
    detail: {
      schemaVersion: "1.0",
      scanStatus: "COMPLETED",
      resourceType: "S3_OBJECT",
      s3ObjectDetails: {
        bucketName: base.quarantineBucket,
        objectKey: "quarantine/" + "b".repeat(64),
        eTag: "synthetic-etag",
        versionId: "synthetic-version",
        s3Throttled: false,
      },
      scanResultDetails: {
        scanResultStatus: "NO_THREATS_FOUND",
        threats: null,
        statusReasons: null,
      },
    },
  };
  const body = JSON.stringify(event),
    message = {
      MessageId: "synthetic-message-1",
      ReceiptHandle: "synthetic-private-receipt",
      Body: body,
      MD5OfBody: createHash("md5").update(body).digest("hex"),
      Attributes: { SentTimestamp: String(Date.parse(at)) },
    };
  return { base, config, event, pattern, policy, body, message };
}
function harness() {
  const f = fixture(),
    commands: unknown[] = [],
    signals: AbortSignal[] = [],
    state = {
      now: at,
      sts: {
        $metadata: metadata,
        Account: f.base.accountId,
        Arn: "arn:aws:sts::111122223333:assumed-role/media-worker/synthetic-session",
        UserId: f.base.workerRoleId + ":synthetic-session",
      } as Record<string, unknown>,
      attributes: {
        QueueArn: f.config.queueArn,
        CreatedTimestamp: createdTimestamp,
        Policy: JSON.stringify(f.policy),
        KmsMasterKeyId: f.base.kmsKeyArn,
        KmsDataKeyReusePeriodSeconds: "300",
        RedriveAllowPolicy: '{"redrivePermission":"denyAll"}',
        VisibilityTimeout: "300",
        ReceiveMessageWaitTimeSeconds: "20",
        MaximumMessageSize: "65536",
        MessageRetentionPeriod: "345600",
        DelaySeconds: "0",
      } as Record<string, unknown>,
      rule: {
        $metadata: metadata,
        Arn: f.base.eventRuleArn,
        Name: "media-clean-scans",
        State: "ENABLED",
        EventBusName: "default",
        EventPattern: JSON.stringify(f.pattern),
      } as Record<string, unknown>,
      targets: {
        $metadata: metadata,
        Targets: [{ Id: f.base.eventTargetId, Arn: f.config.queueArn }],
      } as Record<string, unknown>,
      messages: [structuredClone(f.message)] as unknown[],
      onReceive: undefined as undefined | (() => Promise<void>),
      onDelete: undefined as undefined | (() => Promise<void>),
    };
  const sdk: SqsImageScanIngressSdk = {
    sqs: {
      async send(command, options) {
        commands.push(command);
        signals.push(options.abortSignal);
        if (command instanceof GetQueueAttributesCommand)
          return { $metadata: metadata, Attributes: structuredClone(state.attributes) };
        if (command instanceof ReceiveMessageCommand) {
          await state.onReceive?.();
          return { $metadata: metadata, Messages: structuredClone(state.messages) };
        }
        if (command instanceof DeleteMessageCommand) {
          await state.onDelete?.();
          return { $metadata: metadata };
        }
        throw Error("unexpected controlled SQS command");
      },
    },
    sts: {
      async send(command, options) {
        commands.push(command);
        signals.push(options.abortSignal);
        return structuredClone(state.sts);
      },
    },
    eventBridge: {
      async send(command, options) {
        commands.push(command);
        signals.push(options.abortSignal);
        return structuredClone(command instanceof DescribeRuleCommand ? state.rule : state.targets);
      },
    },
  };
  const options = {
      config: f.config,
      deploymentConfigurationDigest: "sha256:" + "c".repeat(64),
      clock: { now: () => state.now },
      sdk,
    },
    ingress = createSqsImageScanIngress(options);
  return { ...f, state, commands, signals, sdk, options, ingress };
}
async function receipt(h: ReturnType<typeof harness>) {
  const result = await h.ingress.receive();
  if (result === null) throw Error("controlled message required");
  return result;
}
function replacementBody(h: ReturnType<typeof harness>, value: unknown) {
  const body = JSON.stringify(value);
  h.state.messages = [
    { ...h.message, Body: body, MD5OfBody: createHash("md5").update(body).digest("hex") },
  ];
}
it("receives an actual SDK full message with fixed origin/current infrastructure checks and one opaque acknowledgement", async () => {
  const h = harness(),
    result = await receipt(h);
  expect(result.delivery.scanEvent).toEqual(h.event);
  expect(result.delivery.transport).toEqual({
    profile: "GUARDDUTY_SQS_DELIVERY_V1",
    deploymentConfigurationDigest: h.options.deploymentConfigurationDigest,
    queueArn: h.config.queueArn,
    queueCreatedAt: new Date(Number(createdTimestamp) * 1000).toISOString(),
    queuePolicyDigest: h.config.origin.policyDigest,
    messageId: h.message.MessageId,
    bodyDigest: "sha256:" + createHash("sha256").update(h.body).digest("hex"),
    sentAt: at,
    receivedAt: at,
  });
  expect(Object.keys(result).sort()).toEqual(["acknowledge", "delivery"]);
  expect(JSON.stringify(result)).not.toContain(h.message.ReceiptHandle);
  expect(Object.isFrozen(result.delivery.scanEvent)).toBe(true);
  expect(h.commands.filter((c) => c instanceof GetCallerIdentityCommand)).toHaveLength(2);
  expect(h.commands.filter((c) => c instanceof GetQueueAttributesCommand)).toHaveLength(2);
  expect(h.commands.filter((c) => c instanceof DescribeRuleCommand)).toHaveLength(2);
  expect(h.commands.filter((c) => c instanceof ListTargetsByRuleCommand)).toHaveLength(2);
  expect(h.commands.find((c) => c instanceof ReceiveMessageCommand)).toMatchObject({
    input: {
      QueueUrl: h.config.queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 300,
      MessageSystemAttributeNames: ["SentTimestamp"],
    },
  });
  expect(
    h.commands.some(
      (c) => c instanceof DeleteMessageCommand || c instanceof ChangeMessageVisibilityCommand,
    ),
  ).toBe(false);
  await result.acknowledge();
  expect(h.commands.filter((c) => c instanceof DeleteMessageCommand)).toHaveLength(1);
  expect(h.commands.at(-1)).toMatchObject({
    input: { QueueUrl: h.config.queueUrl, ReceiptHandle: h.message.ReceiptHandle },
  });
  await expect(result.acknowledge()).rejects.toThrow(unavailable);
});
it("captures original configuration, clock and SDK receivers before caller mutation", async () => {
  const h = harness();
  Object.assign(h.config, { queueUrl: "https://untrusted.invalid/queue" });
  h.options.clock.now = () => {
    throw Error("new clock must not run");
  };
  h.sdk.sqs.send = async () => {
    throw Error("new SDK must not run");
  };
  const result = await receipt(h);
  expect(result.delivery.transport.queueArn).toBe(h.config.queueArn);
});
it("closes idempotently without destroying injected clients and refuses further receive or acknowledgement", async () => {
  const h = harness(),
    destroy = vi.fn();
  for (const client of [h.sdk.sqs, h.sdk.sts, h.sdk.eventBridge])
    Object.assign(client, { destroy });
  const result = await receipt(h),
    calls = h.commands.length;
  h.ingress.close();
  h.ingress.close();
  await expect(h.ingress.receive()).rejects.toThrow(unavailable);
  await expect(result.acknowledge()).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(calls);
  expect(destroy).not.toHaveBeenCalled();
  const late = harness();
  late.state.onReceive = async () => {
    late.ingress.close();
  };
  await expect(late.ingress.receive()).rejects.toThrow(unavailable);
  expect(late.commands.some((command) => command instanceof DeleteMessageCommand)).toBe(false);
});
it("destroys all default-owned SDK clients once on close and also after deployment failure", async () => {
  const sqs = vi.spyOn(SQSClient.prototype, "destroy").mockImplementation(() => undefined),
    sts = vi.spyOn(STSClient.prototype, "destroy").mockImplementation(() => undefined),
    events = vi.spyOn(EventBridgeClient.prototype, "destroy").mockImplementation(() => undefined),
    f = fixture(),
    ingress = createSqsImageScanIngress({
      config: f.config,
      deploymentConfigurationDigest: "sha256:" + "c".repeat(64),
      clock: { now: () => at },
    });
  ingress.close();
  ingress.close();
  for (const spy of [sqs, sts, events]) expect(spy).toHaveBeenCalledTimes(1);
  await expect(ingress.receive()).rejects.toThrow(unavailable);
  vi.spyOn(STSClient.prototype, "send").mockImplementation(() => {
    throw Error("controlled provider refusal");
  });
  await expect(
    createFreshSqsImageScanQueue({
      deployment: { ...f.base, deploymentRoleId: "AROA" + "D".repeat(17), operationReference: id },
      clock: { now: () => at },
    }),
  ).rejects.toThrow(unavailable);
  for (const spy of [sqs, sts, events]) expect(spy).toHaveBeenCalledTimes(2);
});
it("rejects configuration getters, extra fields, wrong origin or unsupported queue adoption without SDK calls", () => {
  const h = harness();
  let getters = 0;
  const config = { ...h.config };
  Object.defineProperty(config, "origin", {
    enumerable: true,
    get() {
      getters++;
      return h.config.origin;
    },
  });
  expect(() => createSqsImageScanIngress({ ...h.options, config })).toThrow(unavailable);
  expect(getters).toBe(0);
  for (const bad of [
    { ...h.config, trusted: true },
    { ...h.config, region: "us-east-1" },
    { ...h.config, origin: { ...h.config.origin, policyDigest: "sha256:" + "0".repeat(64) } },
    { ...h.config, queueCreatedTimestamp: "01" },
    { ...h.config, workerRoleArn: h.config.deploymentRoleArn },
  ])
    expect(() => parseSqsImageScanIngressConfig(bad)).toThrow(unavailable);
  expect(h.commands).toHaveLength(0);
});
it.each(["Account", "Arn", "UserId"])("refuses wrong actual STS %s before Receive", async (key) => {
  const h = harness();
  h.state.sts[key] = "unexpected";
  await expect(h.ingress.receive()).rejects.toThrow(unavailable);
  expect(h.commands.some((c) => c instanceof ReceiveMessageCommand)).toBe(false);
});
it.each([
  "Policy",
  "KmsMasterKeyId",
  "CreatedTimestamp",
  "RedriveAllowPolicy",
  "RedrivePolicy",
  "VisibilityTimeout",
])("refuses wrong queue %s before Receive", async (key) => {
  const h = harness();
  h.state.attributes[key] =
    key === "Policy"
      ? JSON.stringify({
          ...h.policy,
          Statement: h.policy.Statement.filter((v) => v.Sid !== "DenyOtherSenders"),
        })
      : "unexpected";
  await expect(h.ingress.receive()).rejects.toThrow(unavailable);
  expect(h.commands.some((c) => c instanceof ReceiveMessageCommand)).toBe(false);
});
it.each(["State", "EventBusName", "EventPattern", "RoleArn"])(
  "refuses changed rule %s",
  async (key) => {
    const h = harness();
    h.state.rule[key] = "unexpected";
    await expect(h.ingress.receive()).rejects.toThrow(unavailable);
  },
);
it.each(["Input", "InputPath", "InputTransformer", "RoleArn", "DeadLetterConfig"])(
  "refuses target customization %s instead of the exact raw event",
  async (key) => {
    const h = harness();
    h.state.targets.Targets = [
      { Id: h.base.eventTargetId, Arn: h.config.queueArn, [key]: "unexpected" },
    ];
    await expect(h.ingress.receive()).rejects.toThrow(unavailable);
  },
);
it("rejects paginated target coverage and policy changes during long polling without deleting", async () => {
  const h = harness();
  h.state.targets.NextToken = "unread-targets";
  await expect(h.ingress.receive()).rejects.toThrow(unavailable);
  delete h.state.targets.NextToken;
  h.state.onReceive = async () => {
    h.state.attributes.CreatedTimestamp = String(Number(createdTimestamp) + 1);
  };
  await expect(h.ingress.receive()).rejects.toThrow(unavailable);
  expect(h.commands.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
});
it("returns null for a real empty page without qualifying invented events", async () => {
  const h = harness();
  h.state.messages = [];
  expect(await h.ingress.receive()).toBeNull();
  expect(h.commands.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
});
it.each(["md5", "body", "oversize", "future", "before-origin", "multiple", "missing-handle"])(
  "rejects malformed transport %s",
  async (mode) => {
    const h = harness();
    if (mode === "md5") h.state.messages = [{ ...h.message, MD5OfBody: "0".repeat(32) }];
    if (mode === "body")
      h.state.messages = [
        { ...h.message, Body: "{", MD5OfBody: createHash("md5").update("{").digest("hex") },
      ];
    if (mode === "oversize") replacementBody(h, { padding: "x".repeat(65536) });
    if (mode === "future")
      h.state.messages = [
        { ...h.message, Attributes: { SentTimestamp: String(Date.parse(at) + 1) } },
      ];
    if (mode === "before-origin")
      h.state.messages = [
        {
          ...h.message,
          Attributes: { SentTimestamp: String(Number(createdTimestamp) * 1000 - 1) },
        },
      ];
    if (mode === "multiple") h.state.messages.push(h.message);
    if (mode === "missing-handle") h.state.messages = [{ ...h.message, ReceiptHandle: undefined }];
    await expect(h.ingress.receive()).rejects.toThrow(unavailable);
    expect(h.commands.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
  },
);
it("does not treat valid MD5 as authenticity for an unrelated or non-clean event", async () => {
  for (const event of [
    { ...fixture().event, source: "custom.attacker" },
    { ...fixture().event, account: "999999999999" },
    { ...fixture().event, detail: { ...fixture().event.detail, scanStatus: "FAILED" } },
  ]) {
    const h = harness();
    replacementBody(h, event);
    await expect(h.ingress.receive()).rejects.toThrow(unavailable);
  }
});
it("bounds ignored SDK cancellation and rejects a pre-aborted receive before sending", async () => {
  const h = harness(),
    signal = new AbortController();
  signal.abort();
  await expect(h.ingress.receive(signal.signal)).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(0);
  h.state.onReceive = () => new Promise(() => undefined);
  const pending = expect(h.ingress.receive()).rejects.toThrow(unavailable);
  await vi.advanceTimersByTimeAsync(25001);
  await pending;
  expect(h.signals.at(-1)?.aborted).toBe(true);
});
it.each(["expired", "aborted", "identity", "unknown"])(
  "permits only one current-receipt acknowledgement attempt after %s",
  async (mode) => {
    const h = harness(),
      result = await receipt(h),
      signal = new AbortController();
    if (mode === "expired") h.state.now = new Date(Date.parse(at) + 300000).toISOString();
    if (mode === "aborted") signal.abort();
    if (mode === "identity") h.state.sts.UserId = "AROA" + "B".repeat(17) + ":synthetic-session";
    if (mode === "unknown")
      h.state.onDelete = async () => {
        throw Error("provider secret diagnostic");
      };
    await expect(result.acknowledge(signal.signal)).rejects.toThrow(unavailable);
    await expect(result.acknowledge()).rejects.toThrow(unavailable);
    expect(h.commands.filter((c) => c instanceof DeleteMessageCommand)).toHaveLength(
      mode === "unknown" ? 1 : 0,
    );
  },
);
it("never renews the original receive deadline and refuses clock rollback", async () => {
  const h = harness();
  h.state.onReceive = async () => {
    h.state.now = new Date(Date.parse(at) + 20000).toISOString();
  };
  const result = await receipt(h);
  h.state.now = new Date(Date.parse(at) + 300000).toISOString();
  await expect(result.acknowledge()).rejects.toThrow(unavailable);
  const other = harness(),
    original = await receipt(other);
  other.state.now = new Date(Date.parse(at) - 1).toISOString();
  await expect(original.acknowledge()).rejects.toThrow(unavailable);
});

function deploymentHarness(mode = "fresh") {
  const f = fixture(),
    commands: unknown[] = [],
    deploymentRoleId = "AROA" + "D".repeat(17);
  let queueUrl = "",
    queueArn = "",
    createdAttributes: Record<string, string> = {};
  const sdk: SqsImageScanIngressSdk = {
    sts: {
      async send(command) {
        commands.push(command);
        return {
          $metadata: metadata,
          Account: f.base.accountId,
          Arn: "arn:aws:sts::111122223333:assumed-role/media-provisioner/deployment-session",
          UserId:
            (mode === "worker-role" ? f.base.workerRoleId : deploymentRoleId) +
            ":deployment-session",
        };
      },
    },
    eventBridge: {
      async send() {
        throw Error("Deployment helper does not install or read a rule");
      },
    },
    sqs: {
      async send(command) {
        commands.push(command);
        if (command instanceof GetQueueUrlCommand) {
          if (mode === "existing")
            return { $metadata: metadata, QueueUrl: "https://existing.invalid" };
          throw Object.assign(Error("synthetic absent"), {
            name: mode === "denied" ? "AccessDenied" : "QueueDoesNotExist",
            $metadata: { httpStatusCode: 400 },
          });
        }
        if (command instanceof CreateQueueCommand) {
          queueArn = `arn:aws:sqs:ca-central-1:${f.base.accountId}:${command.input.QueueName}`;
          queueUrl = `https://sqs.ca-central-1.amazonaws.com/${f.base.accountId}/${command.input.QueueName}`;
          createdAttributes = { ...command.input.Attributes } as Record<string, string>;
          if (mode === "unknown-create") throw Error("synthetic acknowledgement lost");
          return { $metadata: metadata, QueueUrl: queueUrl };
        }
        if (command instanceof GetQueueAttributesCommand)
          return {
            $metadata: metadata,
            Attributes: {
              ...createdAttributes,
              QueueArn: queueArn,
              CreatedTimestamp: String(
                Date.parse(at) / 1000 - (mode === "old-incarnation" ? 1 : 0),
              ),
            },
          };
        throw Error("unexpected deployment command");
      },
    },
  };
  const options = {
    deployment: { ...f.base, deploymentRoleId, operationReference: id },
    clock: { now: () => new Date().toISOString() },
    sdk,
  };
  return { options, commands, f };
}
it("creates an unpredictable fresh queue with complete restrictive policy already in CreateQueue and a protected origin receipt", async () => {
  const h = deploymentHarness(),
    pending = createFreshSqsImageScanQueue(h.options);
  await vi.advanceTimersByTimeAsync(1001);
  const result = await pending;
  expect(parseSqsImageScanIngressConfig(result)).toEqual(result);
  expect(result.queueArn).toMatch(/:bop-media-scan-[a-f0-9]{64}$/u);
  expect(result.origin.operationReference).toBe(id);
  const created = h.commands.find((v) => v instanceof CreateQueueCommand);
  if (!(created instanceof CreateQueueCommand)) throw Error("actual CreateQueue command required");
  const attributes = created.input.Attributes;
  if (!attributes?.Policy) throw Error("policy must be present at creation");
  const policy = JSON.parse(attributes.Policy) as { Statement: { Sid: string; Effect: string }[] };
  expect(policy.Statement.filter((v) => v.Effect === "Deny").map((v) => v.Sid)).toEqual([
    "DenyOtherSenders",
    "DenyOtherRules",
    "DenyOtherAccounts",
    "DenyInsecureTransport",
    "DenyOtherConsumers",
    "DenyUnprotectedMutation",
    "DenyRedrive",
  ]);
  expect(attributes.KmsMasterKeyId).toBe(h.f.base.kmsKeyArn);
  expect(attributes.RedriveAllowPolicy).toBe('{"redrivePermission":"denyAll"}');
  expect(
    h.commands.some(
      (v) => v instanceof DescribeRuleCommand || v instanceof ListTargetsByRuleCommand,
    ),
  ).toBe(false);
});
it.each(["existing", "denied", "worker-role", "unknown-create", "old-incarnation"])(
  "does not adopt a queue after deployment failure %s",
  async (mode) => {
    const h = deploymentHarness(mode),
      pending = expect(createFreshSqsImageScanQueue(h.options)).rejects.toThrow(unavailable);
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(h.commands.filter((v) => v instanceof CreateQueueCommand)).toHaveLength(
      ["unknown-create", "old-incarnation"].includes(mode) ? 1 : 0,
    );
    expect(h.commands.filter((v) => v instanceof GetQueueAttributesCommand)).toHaveLength(
      mode === "old-incarnation" ? 1 : 0,
    );
  },
);
