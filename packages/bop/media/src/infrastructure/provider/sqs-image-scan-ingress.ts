import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
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
import { parseMediaInstant, parseMediaReferenceId } from "../../contracts/media.js";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";

export interface SqsImageScanQueueOrigin {
  readonly profile: "MEDIA_IMAGE_SCAN_QUEUE_ORIGIN_V1";
  readonly operationReference: string;
  readonly queueArn: string;
  readonly queueUrl: string;
  readonly queueCreatedTimestamp: string;
  readonly policyDigest: string;
  readonly createdAt: string;
}
interface DeploymentIdentity {
  readonly region: "ca-central-1";
  readonly accountId: string;
  readonly kmsKeyArn: string;
  readonly workerRoleArn: string;
  readonly workerRoleId: string;
  readonly deploymentRoleArn: string;
  readonly eventRuleArn: string;
  readonly eventTargetId: string;
  readonly quarantineBucket: string;
  readonly protectionPlanArn: string;
}
export interface SqsImageScanIngressConfig extends DeploymentIdentity {
  readonly queueArn: string;
  readonly queueUrl: string;
  /** Canonical decimal epoch seconds returned by SQS, not a caller time guess. */
  readonly queueCreatedTimestamp: string;
  /** Persist this receipt in protected deployment configuration. It is not an
   * authenticated statement when supplied as arbitrary request JSON. */
  readonly origin: SqsImageScanQueueOrigin;
}
type SqsCommand =
  | GetQueueAttributesCommand
  | ReceiveMessageCommand
  | DeleteMessageCommand
  | GetQueueUrlCommand
  | CreateQueueCommand;
export interface SqsImageScanIngressSdk {
  readonly sqs: {
    send(command: SqsCommand, options: { readonly abortSignal: AbortSignal }): Promise<unknown>;
  };
  readonly sts: {
    send(
      command: GetCallerIdentityCommand,
      options: { readonly abortSignal: AbortSignal },
    ): Promise<unknown>;
  };
  readonly eventBridge: {
    send(
      command: DescribeRuleCommand | ListTargetsByRuleCommand,
      options: { readonly abortSignal: AbortSignal },
    ): Promise<unknown>;
  };
}
export interface SqsImageScanDelivery {
  readonly scanEvent: unknown;
  readonly transport: {
    readonly profile: "GUARDDUTY_SQS_DELIVERY_V1";
    readonly deploymentConfigurationDigest: string;
    readonly queueArn: string;
    readonly queueCreatedAt: string;
    readonly queuePolicyDigest: string;
    readonly messageId: string;
    readonly bodyDigest: string;
    readonly sentAt: string;
    readonly receivedAt: string;
  };
}
export interface SqsImageScanIngressOptions {
  readonly config: SqsImageScanIngressConfig;
  readonly deploymentConfigurationDigest: string;
  readonly clock: { now(): string };
  readonly sdk?: SqsImageScanIngressSdk;
}
export interface FreshSqsImageScanQueueOptions {
  readonly deployment: DeploymentIdentity & {
    readonly deploymentRoleId: string;
    readonly operationReference: string;
  };
  readonly clock: { now(): string };
  readonly sdk?: SqsImageScanIngressSdk;
}
export class MediaScanIngressUnavailableError extends Error {
  readonly code = "MEDIA_SCAN_INGRESS_UNAVAILABLE";
  constructor() {
    super("Media scan ingress is unavailable");
    this.name = "MediaScanIngressUnavailableError";
  }
}
const fail = (): never => {
  throw new MediaScanIngressUnavailableError();
};
const maxBodyBytes = 65536,
  visibilityMs = 300000;
const identityKeys = [
  "region",
  "accountId",
  "kmsKeyArn",
  "workerRoleArn",
  "workerRoleId",
  "deploymentRoleArn",
  "eventRuleArn",
  "eventTargetId",
  "quarantineBucket",
  "protectionPlanArn",
] as const;
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d) return undefined;
  return d.enumerable && "value" in d ? d.value : fail();
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return fail();
    result[key] = field(value, key);
  }
  return result;
}
function string(value: unknown, pattern: RegExp, maximum = 1024): string {
  return typeof value === "string" && value.length <= maximum && pattern.test(value)
    ? value
    : fail();
}
const digest = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
const hash = (value: unknown) => string(value, /^sha256:[a-f0-9]{64}$/u);
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function seconds(value: unknown): string {
  const raw = string(value, /^[1-9][0-9]{0,10}$/u),
    n = Number(raw);
  if (!Number.isSafeInteger(n) || !Number.isFinite(new Date(n * 1000).valueOf())) return fail();
  return raw;
}
const queueInstant = (value: string) =>
  parseMediaInstant(new Date(Number(value) * 1000).toISOString());
function identity(r: Record<string, unknown>): DeploymentIdentity {
  if (r.region !== "ca-central-1") return fail();
  const accountId = string(r.accountId, /^[0-9]{12}$/u),
    workerRoleArn = string(
      r.workerRoleArn,
      new RegExp(
        `^arn:aws:iam::${accountId}:role/(?:[A-Za-z0-9+=,.@_-]+/)*[A-Za-z0-9+=,.@_-]+$`,
        "u",
      ),
      576,
    ),
    deploymentRoleArn = string(
      r.deploymentRoleArn,
      new RegExp(
        `^arn:aws:iam::${accountId}:role/(?:[A-Za-z0-9+=,.@_-]+/)*[A-Za-z0-9+=,.@_-]+$`,
        "u",
      ),
      576,
    );
  if (workerRoleArn === deploymentRoleArn) return fail();
  return Object.freeze({
    region: "ca-central-1",
    accountId,
    workerRoleArn,
    deploymentRoleArn,
    workerRoleId: string(r.workerRoleId, /^AROA[A-Z0-9]{17}$/u),
    kmsKeyArn: string(
      r.kmsKeyArn,
      new RegExp(
        `^arn:aws:kms:ca-central-1:${accountId}:key/(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$`,
        "u",
      ),
    ),
    eventRuleArn: string(
      r.eventRuleArn,
      new RegExp(`^arn:aws:events:ca-central-1:${accountId}:rule/[A-Za-z0-9._-]{1,64}$`, "u"),
    ),
    eventTargetId: string(r.eventTargetId, /^[A-Za-z0-9._-]{1,64}$/u),
    quarantineBucket: string(r.quarantineBucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u),
    protectionPlanArn: string(
      r.protectionPlanArn,
      new RegExp(
        `^arn:aws:guardduty:ca-central-1:${accountId}:malware-protection-plan/[A-Za-z0-9]{1,64}$`,
        "u",
      ),
    ),
  });
}
function queuePolicy(c: DeploymentIdentity & { readonly queueArn: string }) {
  const statement = (
    Sid: string,
    Effect: "Allow" | "Deny",
    Principal: unknown,
    Action: unknown,
    Condition?: unknown,
  ) => ({
    Sid,
    Effect,
    Principal,
    Action,
    Resource: c.queueArn,
    ...(Condition === undefined ? {} : { Condition }),
  });
  return {
    Version: "2012-10-17",
    Statement: [
      statement(
        "ExactGuardDutyRule",
        "Allow",
        { Service: "events.amazonaws.com" },
        "sqs:SendMessage",
        {
          ArnEquals: { "aws:SourceArn": c.eventRuleArn },
          StringEquals: { "aws:SourceAccount": c.accountId },
        },
      ),
      statement("DenyOtherSenders", "Deny", "*", "sqs:SendMessage", {
        StringNotEquals: { "aws:PrincipalServiceName": "events.amazonaws.com" },
      }),
      statement("DenyOtherRules", "Deny", "*", "sqs:SendMessage", {
        ArnNotEquals: { "aws:SourceArn": c.eventRuleArn },
      }),
      statement("DenyOtherAccounts", "Deny", "*", "sqs:SendMessage", {
        StringNotEquals: { "aws:SourceAccount": c.accountId },
      }),
      statement("DenyInsecureTransport", "Deny", "*", "sqs:*", {
        Bool: { "aws:SecureTransport": "false" },
      }),
      statement(
        "DenyOtherConsumers",
        "Deny",
        "*",
        ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"],
        { ArnNotEquals: { "aws:PrincipalArn": c.workerRoleArn } },
      ),
      statement(
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
        { ArnNotEquals: { "aws:PrincipalArn": c.deploymentRoleArn } },
      ),
      statement("DenyRedrive", "Deny", "*", [
        "sqs:StartMessageMoveTask",
        "sqs:CancelMessageMoveTask",
      ]),
    ],
  };
}
function rulePattern(c: DeploymentIdentity) {
  return {
    source: ["aws.guardduty"],
    "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
    account: [c.accountId],
    region: [c.region],
    resources: [c.protectionPlanArn],
    detail: {
      schemaVersion: ["1.0"],
      scanStatus: ["COMPLETED"],
      resourceType: ["S3_OBJECT"],
      s3ObjectDetails: { bucketName: [c.quarantineBucket], s3Throttled: [false] },
      scanResultDetails: { scanResultStatus: ["NO_THREATS_FOUND"] },
    },
  };
}
export function parseSqsImageScanIngressConfig(value: unknown): SqsImageScanIngressConfig {
  try {
    const r = closed(value, [
        ...identityKeys,
        "queueArn",
        "queueUrl",
        "queueCreatedTimestamp",
        "origin",
      ]),
      base = identity(r),
      queueArn = string(
        r.queueArn,
        new RegExp(`^arn:aws:sqs:ca-central-1:${base.accountId}:bop-media-scan-[a-f0-9]{64}$`, "u"),
      ),
      name = queueArn.slice(queueArn.lastIndexOf(":") + 1),
      queueUrl = `https://sqs.ca-central-1.amazonaws.com/${base.accountId}/${name}`;
    if (r.queueUrl !== queueUrl) return fail();
    const queueCreatedTimestamp = seconds(r.queueCreatedTimestamp),
      o = closed(r.origin, [
        "profile",
        "operationReference",
        "queueArn",
        "queueUrl",
        "queueCreatedTimestamp",
        "policyDigest",
        "createdAt",
      ]);
    if (
      o.profile !== "MEDIA_IMAGE_SCAN_QUEUE_ORIGIN_V1" ||
      o.queueArn !== queueArn ||
      o.queueUrl !== queueUrl ||
      o.queueCreatedTimestamp !== queueCreatedTimestamp
    )
      return fail();
    const origin: SqsImageScanQueueOrigin = Object.freeze({
      profile: "MEDIA_IMAGE_SCAN_QUEUE_ORIGIN_V1",
      operationReference: parseMediaReferenceId(o.operationReference),
      queueArn,
      queueUrl,
      queueCreatedTimestamp,
      policyDigest: hash(o.policyDigest),
      createdAt: parseMediaInstant(o.createdAt),
    });
    if (
      origin.policyDigest !== digest(queuePolicy({ ...base, queueArn })) ||
      queueInstant(queueCreatedTimestamp) > origin.createdAt
    )
      return fail();
    return Object.freeze({ ...base, queueArn, queueUrl, queueCreatedTimestamp, origin });
  } catch {
    return fail();
  }
}
function json(value: unknown, maximum = maxBodyBytes): unknown {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximum ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  )
    return fail();
  return copyMediaUploadStorageValue(JSON.parse(value));
}
function success(value: unknown): void {
  if (field(field(value, "$metadata"), "httpStatusCode") !== 200) return fail();
}
function captureSend<T>(owner: {
  send(command: T, options: { readonly abortSignal: AbortSignal }): Promise<unknown>;
}) {
  let current: object | null = owner;
  while (current !== null) {
    const d = Object.getOwnPropertyDescriptor(current, "send");
    if (d)
      return "value" in d && typeof d.value === "function"
        ? (d.value as typeof owner.send).bind(owner)
        : fail();
    current = Object.getPrototypeOf(current) as object | null;
  }
  return fail();
}
function clients(value: unknown) {
  const owned =
    value === undefined
      ? {
          sqs: new SQSClient({
            region: "ca-central-1",
            endpoint: "https://sqs.ca-central-1.amazonaws.com",
            maxAttempts: 1,
          }),
          sts: new STSClient({
            region: "ca-central-1",
            endpoint: "https://sts.ca-central-1.amazonaws.com",
            maxAttempts: 1,
          }),
          eventBridge: new EventBridgeClient({
            region: "ca-central-1",
            endpoint: "https://events.ca-central-1.amazonaws.com",
            maxAttempts: 1,
          }),
        }
      : undefined;
  const selected = owned ?? closed(value, ["sqs", "sts", "eventBridge"]);
  let stopped = false;
  const assertOpen = () => {
    if (stopped) return fail();
  };
  const captured = <T>(owner: {
    send(command: T, options: { readonly abortSignal: AbortSignal }): Promise<unknown>;
  }) => {
    const send = captureSend(owner);
    return async (command: T, options: { readonly abortSignal: AbortSignal }) => {
      assertOpen();
      const result = await send(command, options);
      assertOpen();
      return result;
    };
  };
  return {
    sqs: captured(selected.sqs as SqsImageScanIngressSdk["sqs"]),
    sts: captured(selected.sts as SqsImageScanIngressSdk["sts"]),
    eventBridge: captured(selected.eventBridge as SqsImageScanIngressSdk["eventBridge"]),
    assertOpen,
    close() {
      if (stopped) return;
      stopped = true;
      // Injected clients remain caller-owned. The server drains its active cycle
      // before close; closed send wrappers also reject any late SDK completion.
      let failed = false;
      if (owned)
        for (const client of [owned.sqs, owned.sts, owned.eventBridge]) {
          try {
            client.destroy();
          } catch {
            failed = true;
          }
        }
      if (failed) return fail();
    },
  };
}
function clock(value: unknown) {
  const r = closed(value, ["now"]);
  if (typeof r.now !== "function") return fail();
  const raw = (r.now as () => string).bind(value);
  let latest = "";
  return () => {
    const at = parseMediaInstant(raw());
    if (at < latest) return fail();
    latest = at;
    return at;
  };
}
async function bounded<T>(
  send: (command: T, options: { readonly abortSignal: AbortSignal }) => Promise<unknown>,
  command: T,
  signal?: AbortSignal,
  milliseconds = 5000,
) {
  if (signal?.aborted) return fail();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new MediaScanIngressUnavailableError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, milliseconds);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => send(command, { abortSignal: controller.signal })),
      interrupted,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
async function caller(
  send: ReturnType<typeof clients>["sts"],
  c: DeploymentIdentity,
  roleArn: string,
  roleId: string,
  signal?: AbortSignal,
) {
  const response = await bounded(send, new GetCallerIdentityCommand({}), signal);
  success(response);
  const arn = field(response, "Arn"),
    userId = field(response, "UserId"),
    roleName = roleArn.slice(roleArn.lastIndexOf("/") + 1),
    prefix = `arn:aws:sts::${c.accountId}:assumed-role/${roleName}/`;
  if (
    field(response, "Account") !== c.accountId ||
    typeof arn !== "string" ||
    !arn.startsWith(prefix) ||
    !/^[A-Za-z0-9+=,.@_-]{2,64}$/u.test(arn.slice(prefix.length)) ||
    userId !== `${roleId}:${arn.slice(prefix.length)}`
  )
    return fail();
}
function attributes(c: DeploymentIdentity & { readonly queueArn: string }) {
  return {
    Policy: canonicalizeRfc8785(queuePolicy(c)),
    KmsMasterKeyId: c.kmsKeyArn,
    KmsDataKeyReusePeriodSeconds: "300",
    RedriveAllowPolicy: '{"redrivePermission":"denyAll"}',
    VisibilityTimeout: "300",
    ReceiveMessageWaitTimeSeconds: "20",
    MaximumMessageSize: String(maxBodyBytes),
    MessageRetentionPeriod: "345600",
    DelaySeconds: "0",
  };
}
async function queue(
  send: ReturnType<typeof clients>["sqs"],
  c: DeploymentIdentity & { readonly queueArn: string; readonly queueUrl: string },
  signal?: AbortSignal,
) {
  const result = await bounded(
    send,
    new GetQueueAttributesCommand({ QueueUrl: c.queueUrl, AttributeNames: ["All"] }),
    signal,
  );
  success(result);
  const a = field(result, "Attributes");
  if (
    field(a, "QueueArn") !== c.queueArn ||
    !equal(json(field(a, "Policy")), queuePolicy(c)) ||
    !equal(json(field(a, "RedriveAllowPolicy")), { redrivePermission: "denyAll" }) ||
    field(a, "RedrivePolicy") !== undefined ||
    (field(a, "FifoQueue") !== undefined && field(a, "FifoQueue") !== "false") ||
    (field(a, "SqsManagedSseEnabled") !== undefined && field(a, "SqsManagedSseEnabled") !== "false")
  )
    return fail();
  for (const [key, expected] of Object.entries(attributes(c))) {
    if (key !== "Policy" && key !== "RedriveAllowPolicy" && field(a, key) !== expected)
      return fail();
  }
  return seconds(field(a, "CreatedTimestamp"));
}
async function verify(
  sdk: ReturnType<typeof clients>,
  c: SqsImageScanIngressConfig,
  signal?: AbortSignal,
) {
  await caller(sdk.sts, c, c.workerRoleArn, c.workerRoleId, signal);
  if ((await queue(sdk.sqs, c, signal)) !== c.queueCreatedTimestamp) return fail();
  const name = c.eventRuleArn.slice(c.eventRuleArn.lastIndexOf("/") + 1),
    rule = await bounded(
      sdk.eventBridge,
      new DescribeRuleCommand({ Name: name, EventBusName: "default" }),
      signal,
    );
  success(rule);
  if (
    field(rule, "Arn") !== c.eventRuleArn ||
    field(rule, "Name") !== name ||
    field(rule, "State") !== "ENABLED" ||
    field(rule, "EventBusName") !== "default" ||
    field(rule, "RoleArn") !== undefined ||
    field(rule, "ScheduleExpression") !== undefined ||
    field(rule, "ManagedBy") !== undefined ||
    !equal(json(field(rule, "EventPattern")), rulePattern(c))
  )
    return fail();
  const targetResult = await bounded(
    sdk.eventBridge,
    new ListTargetsByRuleCommand({ Rule: name, EventBusName: "default", Limit: 100 }),
    signal,
  );
  success(targetResult);
  const targets = copyMediaUploadStorageValue(field(targetResult, "Targets"));
  if (
    field(targetResult, "NextToken") !== undefined ||
    !Array.isArray(targets) ||
    targets.length !== 1 ||
    !equal(targets[0], { Id: c.eventTargetId, Arn: c.queueArn })
  )
    return fail();
}
function eventEnvelope(value: unknown, c: DeploymentIdentity) {
  // The owning Media scan parser subsequently binds the complete event to its
  // finalized object. Here only the configured full GuardDuty envelope is admitted.
  const e = closed(value, [
      "version",
      "id",
      "detail-type",
      "source",
      "account",
      "time",
      "region",
      "resources",
      "detail",
    ]),
    d = field(e, "detail"),
    object = field(d, "s3ObjectDetails"),
    result = field(d, "scanResultDetails");
  if (
    e.version !== "0" ||
    e.source !== "aws.guardduty" ||
    e["detail-type"] !== "GuardDuty Malware Protection Object Scan Result" ||
    e.account !== c.accountId ||
    e.region !== c.region ||
    !equal(e.resources, [c.protectionPlanArn]) ||
    field(d, "schemaVersion") !== "1.0" ||
    field(d, "scanStatus") !== "COMPLETED" ||
    field(d, "resourceType") !== "S3_OBJECT" ||
    field(object, "bucketName") !== c.quarantineBucket ||
    field(object, "s3Throttled") !== false ||
    field(result, "scanResultStatus") !== "NO_THREATS_FOUND"
  )
    return fail();
  string(e.id, /^[A-Za-z0-9._:-]{1,128}$/u);
  parseMediaInstant(e.time);
  return value;
}

/** Private SDK adapter. Public server assembly never accepts sdk/event inputs.
 * MD5 checks transport bytes, not authenticity. Protected fresh-queue origin and
 * current AWS role/policy/rule checks are all necessary; timestamps alone cannot
 * reconstruct an unknown queue's producer-policy or redrive history. */
export function createSqsImageScanIngress(options: SqsImageScanIngressOptions) {
  let c: SqsImageScanIngressConfig,
    configurationDigest: string,
    now: () => ReturnType<typeof parseMediaInstant>,
    sdk: ReturnType<typeof clients>;
  try {
    const keys = [
        "config",
        "deploymentConfigurationDigest",
        "clock",
        ...(Object.hasOwn(options, "sdk") ? ["sdk"] : []),
      ],
      r = closed(options, keys);
    c = parseSqsImageScanIngressConfig(r.config);
    configurationDigest = hash(r.deploymentConfigurationDigest);
    now = clock(r.clock);
    if (c.origin.createdAt > now()) return fail();
    sdk = clients(r.sdk);
  } catch {
    return fail();
  }
  let receiving = false;
  return Object.freeze({
    close() {
      sdk.close();
    },
    async receive(signal?: AbortSignal): Promise<null | {
      readonly delivery: SqsImageScanDelivery;
      acknowledge(signal?: AbortSignal): Promise<void>;
    }> {
      sdk.assertOpen();
      if (receiving) return fail();
      receiving = true;
      try {
        now();
        await verify(sdk, c, signal);
        now();
        const startAt = now(),
          monotonicDeadline = performance.now() + visibilityMs,
          deadline = Date.parse(startAt) + visibilityMs,
          response = await bounded(
            sdk.sqs,
            new ReceiveMessageCommand({
              QueueUrl: c.queueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 20,
              VisibilityTimeout: 300,
              MessageSystemAttributeNames: ["SentTimestamp"],
            }),
            signal,
            25000,
          );
        success(response);
        const receivedAt = now(),
          received = field(response, "Messages");
        if (received === undefined) return null;
        const messages = received;
        if (
          !Array.isArray(messages) ||
          Object.getPrototypeOf(messages) !== Array.prototype ||
          messages.length > 1 ||
          Reflect.ownKeys(messages).length !== messages.length + 1
        )
          return fail();
        if (messages.length === 0) return null;
        const message = field(messages, "0"),
          body = field(message, "Body"),
          md5 = field(message, "MD5OfBody"),
          handle = string(field(message, "ReceiptHandle"), /^[\x21-\x7e]+$/u, 2048),
          messageId = string(field(message, "MessageId"), /^[A-Za-z0-9-]{1,128}$/u),
          sent = string(
            field(field(message, "Attributes"), "SentTimestamp"),
            /^[1-9][0-9]{0,15}$/u,
          ),
          sentNumber = Number(sent);
        if (
          typeof body !== "string" ||
          body.length > maxBodyBytes ||
          Buffer.byteLength(body, "utf8") > maxBodyBytes ||
          string(md5, /^[a-f0-9]{32}$/u) !== createHash("md5").update(body, "utf8").digest("hex") ||
          !Number.isSafeInteger(sentNumber) ||
          sentNumber < Number(c.queueCreatedTimestamp) * 1000 ||
          sentNumber > Date.parse(receivedAt)
        )
          return fail();
        const scanEvent = eventEnvelope(json(body), c);
        await verify(sdk, c, signal);
        now();
        if (Date.parse(now()) >= deadline || performance.now() >= monotonicDeadline) return fail();
        const delivery: SqsImageScanDelivery = Object.freeze({
          scanEvent,
          transport: Object.freeze({
            profile: "GUARDDUTY_SQS_DELIVERY_V1",
            deploymentConfigurationDigest: configurationDigest,
            queueArn: c.queueArn,
            queueCreatedAt: queueInstant(c.queueCreatedTimestamp),
            queuePolicyDigest: c.origin.policyDigest,
            messageId,
            bodyDigest: "sha256:" + createHash("sha256").update(body, "utf8").digest("hex"),
            sentAt: parseMediaInstant(new Date(sentNumber).toISOString()),
            receivedAt,
          }),
        });
        let attempted = false;
        return Object.freeze({
          delivery,
          async acknowledge(ackSignal?: AbortSignal) {
            if (attempted) return fail();
            attempted = true;
            try {
              sdk.assertOpen();
              if (
                ackSignal?.aborted ||
                Date.parse(now()) >= deadline ||
                performance.now() >= monotonicDeadline
              )
                return fail();
              await caller(sdk.sts, c, c.workerRoleArn, c.workerRoleId, ackSignal);
              if (Date.parse(now()) >= deadline || performance.now() >= monotonicDeadline)
                return fail();
              const deleted = await bounded(
                sdk.sqs,
                new DeleteMessageCommand({ QueueUrl: c.queueUrl, ReceiptHandle: handle }),
                ackSignal,
              );
              success(deleted);
              if (Date.parse(now()) >= deadline || performance.now() >= monotonicDeadline)
                return fail();
            } catch {
              return fail();
            }
          },
        });
      } catch {
        return fail();
      } finally {
        receiving = false;
      }
    },
  });
}

/** Controlled deployment only: separate STS role, unpredictable never-adopted
 * name, fixed policy present in CreateQueue. It does not install the EventBridge
 * rule/target or execute at Worker startup. Retain the returned origin securely. */
export async function createFreshSqsImageScanQueue(
  options: FreshSqsImageScanQueueOptions,
): Promise<SqsImageScanIngressConfig> {
  let sdk: ReturnType<typeof clients> | undefined;
  try {
    const r = closed(options, [
        "deployment",
        "clock",
        ...(Object.hasOwn(options, "sdk") ? ["sdk"] : []),
      ]),
      d = closed(r.deployment, [...identityKeys, "deploymentRoleId", "operationReference"]),
      base = identity(d),
      deploymentRoleId = string(d.deploymentRoleId, /^AROA[A-Z0-9]{17}$/u),
      operationReference = parseMediaReferenceId(d.operationReference),
      now = clock(r.clock),
      startAt = now(),
      name = "bop-media-scan-" + randomBytes(32).toString("hex"),
      queueArn = `arn:aws:sqs:ca-central-1:${base.accountId}:${name}`,
      queueUrl = `https://sqs.ca-central-1.amazonaws.com/${base.accountId}/${name}`,
      c = { ...base, queueArn, queueUrl };
    if (deploymentRoleId === base.workerRoleId) return fail();
    sdk = clients(r.sdk);
    await caller(sdk.sts, base, base.deploymentRoleArn, deploymentRoleId);
    let absent = false;
    try {
      await bounded(
        sdk.sqs,
        new GetQueueUrlCommand({ QueueName: name, QueueOwnerAWSAccountId: base.accountId }),
      );
    } catch (error) {
      const errorName = field(error, "name"),
        status = field(field(error, "$metadata"), "httpStatusCode");
      absent =
        (errorName === "QueueDoesNotExist" ||
          errorName === "AWS.SimpleQueueService.NonExistentQueue") &&
        status === 400;
    }
    if (!absent) return fail();
    const created = await bounded(
      sdk.sqs,
      new CreateQueueCommand({ QueueName: name, Attributes: attributes(c) }),
    );
    success(created);
    if (field(created, "QueueUrl") !== queueUrl) return fail();
    // SQS documents a one-second delay before using a freshly created queue.
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    const queueCreatedTimestamp = await queue(sdk.sqs, c),
      at = now();
    if (
      Number(queueCreatedTimestamp) < Math.floor(Date.parse(startAt) / 1000) ||
      Number(queueCreatedTimestamp) > Math.floor(Date.parse(at) / 1000)
    )
      return fail();
    await caller(sdk.sts, base, base.deploymentRoleArn, deploymentRoleId);
    return parseSqsImageScanIngressConfig({
      ...c,
      queueCreatedTimestamp,
      origin: {
        profile: "MEDIA_IMAGE_SCAN_QUEUE_ORIGIN_V1",
        operationReference,
        queueArn,
        queueUrl,
        queueCreatedTimestamp,
        policyDigest: digest(queuePolicy(c)),
        createdAt: now(),
      },
    });
  } catch {
    return fail();
  } finally {
    sdk?.close();
  }
}
