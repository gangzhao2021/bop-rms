import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { TextDecoder } from "node:util";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
} from "../contracts/identity-actor.js";

const purpose = "WORKFORCE_ACCOUNT_BINDING";
const unavailable = (): never => {
  throw new Error("WORKFORCE_ACCOUNT_BINDING_APPROVAL_UNAVAILABLE");
};
const ref = (value: unknown): string => parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID");
const instant = (value: unknown): string => {
  const result = parseCanonicalInstant(value);
  if (result.startsWith("0000-")) return unavailable();
  return result;
};
const list = (value: unknown, maximum: number): readonly unknown[] => {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return unavailable();
  return Object.freeze(
    Array.from({ length: value.length }, (_, i) => {
      const entry = Object.getOwnPropertyDescriptor(value, String(i));
      if (!entry?.enumerable || !("value" in entry)) return unavailable();
      return entry.value;
    }),
  );
};
function configuration(value: unknown) {
  const r = readClosedRecord(value, ["environment", "issuer", "clientIds"]);
  if (
    typeof r.environment !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(r.environment) ||
    typeof r.issuer !== "string" ||
    !/^https:\/\/cognito-idp\.ca-central-1\.amazonaws\.com\/ca-central-1_[A-Za-z0-9]{1,42}$/u.test(
      r.issuer,
    )
  )
    return unavailable();
  const clients = list(r.clientIds, 8).map((value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9]{1,128}$/u.test(value)) return unavailable();
    return value;
  });
  if (!clients.length || new Set(clients).size !== clients.length) return unavailable();
  return Object.freeze({
    environment: r.environment,
    issuer: r.issuer,
    clientIds: Object.freeze(clients.sort()),
  });
}
export interface WorkforceAccountBindingApprovalExpected {
  readonly configuration: {
    readonly environment: string;
    readonly issuer: string;
    readonly clientIds: readonly string[];
  };
  readonly operationReference: string;
  readonly actorReference: string;
  readonly intentDigest: string;
  readonly operatorReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
}
const expectedKeys = [
  "configuration",
  "operationReference",
  "actorReference",
  "intentDigest",
  "operatorReference",
  "approvedByReference",
  "approvalEvidenceReference",
];
function expected(value: unknown): WorkforceAccountBindingApprovalExpected {
  const r = readClosedRecord(value, expectedKeys);
  if (typeof r.intentDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(r.intentDigest))
    return unavailable();
  const operatorReference = ref(r.operatorReference),
    approvedByReference = ref(r.approvedByReference);
  if (operatorReference === approvedByReference) return unavailable();
  return Object.freeze({
    configuration: configuration(r.configuration),
    operationReference: ref(r.operationReference),
    actorReference: ref(r.actorReference),
    intentDigest: r.intentDigest,
    operatorReference,
    approvedByReference,
    approvalEvidenceReference: ref(r.approvalEvidenceReference),
  });
}
function base64(value: unknown, bytes: number): string {
  if (
    typeof value !== "string" ||
    value.length !== Math.ceil((bytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return unavailable();
  const parsed = Buffer.from(value, "base64url");
  if (parsed.length !== bytes || parsed.toString("base64url") !== value) return unavailable();
  return value;
}
function approval(value: unknown) {
  const r = readClosedRecord(value, [
    "profile",
    "purposeCode",
    ...expectedKeys,
    "keyReference",
    "notBefore",
    "validUntil",
    "signature",
  ]);
  if (r.profile !== "WorkforceAccountBindingApprovalV1" || r.purposeCode !== purpose)
    return unavailable();
  const binding = expected(Object.fromEntries(expectedKeys.map((key) => [key, r[key]]))),
    notBefore = instant(r.notBefore),
    validUntil = instant(r.validUntil);
  if (notBefore >= validUntil) return unavailable();
  return Object.freeze({
    profile: "WorkforceAccountBindingApprovalV1" as const,
    purposeCode: purpose,
    ...binding,
    keyReference: ref(r.keyReference),
    notBefore,
    validUntil,
    signature: base64(r.signature, 64),
  });
}
/** Actual issuer-side signing uses this closed message; no signing key is shipped. */
export function workforceAccountBindingApprovalSigningBytes(value: unknown): string {
  try {
    const { signature, ...payload } = approval(value);
    void signature;
    return "BOP-RMS:WorkforceAccountBindingApprovalV1\n" + canonicalizeRfc8785(payload);
  } catch {
    return unavailable();
  }
}
function trust(value: unknown) {
  const r = readClosedRecord(value, ["profile", "keys", "withdrawnApprovalEvidenceReferences"]);
  if (r.profile !== "WorkforceAccountBindingTrustV1") return unavailable();
  const keys = list(r.keys, 32).map((value) => {
      const k = readClosedRecord(value, [
        "keyReference",
        "approvedByReference",
        "configuration",
        "purposeCode",
        "notBefore",
        "validUntil",
        "publicKeySpki",
      ]);
      if (k.purposeCode !== purpose) return unavailable();
      const notBefore = instant(k.notBefore),
        validUntil = instant(k.validUntil);
      if (notBefore >= validUntil) return unavailable();
      return Object.freeze({
        keyReference: ref(k.keyReference),
        approvedByReference: ref(k.approvedByReference),
        configuration: configuration(k.configuration),
        purposeCode: purpose,
        notBefore,
        validUntil,
        publicKeySpki: base64(k.publicKeySpki, 44),
      });
    }),
    withdrawnApprovalEvidenceReferences = list(r.withdrawnApprovalEvidenceReferences, 256).map(ref);
  if (
    new Set(keys.map((k) => k.keyReference)).size !== keys.length ||
    new Set(withdrawnApprovalEvidenceReferences).size !== withdrawnApprovalEvidenceReferences.length
  )
    return unavailable();
  return Object.freeze({
    keys: Object.freeze(keys),
    withdrawnApprovalEvidenceReferences: Object.freeze(withdrawnApprovalEvidenceReferences),
  });
}
function path(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value
  )
    return unavailable();
  return value;
}
async function readPrivateJson(file: string): Promise<unknown> {
  if (typeof process.getuid !== "function") return unavailable();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true }),
      mode = before.mode & 0o7777n;
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      (mode !== 0o600n && mode !== 0o400n) ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > 65_536n
    )
      return unavailable();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    for (const current of [
      await handle.stat({ bigint: true }),
      await lstat(file, { bigint: true }),
    ]) {
      if (
        !current.isFile() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.uid !== before.uid ||
        current.mode !== before.mode ||
        current.nlink !== before.nlink ||
        current.mtimeNs !== before.mtimeNs ||
        current.ctimeNs !== before.ctimeNs
      )
        return unavailable();
    }
    if (total !== Number(before.size)) return unavailable();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total)));
  } catch {
    return unavailable();
  } finally {
    if (handle) await handle.close().catch(unavailable);
  }
}
export interface WorkforceAccountBindingApprovalTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface WorkforceAccountBindingApprovalFileOptions {
  readonly approvalPath: string;
  readonly trustPath: string;
  readonly clock: { now(): string };
  readonly transaction: WorkforceAccountBindingApprovalTransaction;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: WorkforceAccountBindingApprovalTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void>;
}
const optionKeys = [
  "approvalPath",
  "trustPath",
  "clock",
  "transaction",
  "originalObservedAt",
  "originalValidUntil",
  "registerBeforeCommit",
];
/** Fixed deployment-only paths. The importer separately authenticates its actual
 * operator and verifies the stored invitation/current Provider. This signature
 * explicitly approves the Actor-to-subject binding; it grants no business role. */
export function createFileWorkforceAccountBindingApprovalSource(
  options: WorkforceAccountBindingApprovalFileOptions,
) {
  readClosedRecord(options, optionKeys);
  const approvalPath = path(options.approvalPath),
    trustPath = path(options.trustPath),
    clock = options.clock,
    now = clock.now,
    tx = options.transaction,
    query = tx.query,
    register = options.registerBeforeCommit,
    origin = instant(options.originalObservedAt),
    originalDeadline = instant(options.originalValidUntil);
  if (
    approvalPath === trustPath ||
    originalDeadline <= origin ||
    Date.parse(originalDeadline) > Date.parse(origin) + 5000 ||
    [now, query, register].some((f) => typeof f !== "function")
  )
    return unavailable();
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    guarded = false,
    guardCalls = 0,
    latest = origin,
    deadline = originalDeadline,
    pinned: WorkforceAccountBindingApprovalExpected | undefined,
    approvalBytes: string | undefined,
    keyBytes: string | undefined;
  const poison = (): never => {
    phase = "Poison";
    return unavailable();
  };
  const check = () => {
    try {
      readClosedRecord(options, optionKeys);
      if (
        phase === "Poison" ||
        phase === "Final" ||
        options.approvalPath !== approvalPath ||
        options.trustPath !== trustPath ||
        options.clock !== clock ||
        clock.now !== now ||
        options.transaction !== tx ||
        tx.query !== query ||
        options.registerBeforeCommit !== register ||
        options.originalObservedAt !== origin ||
        options.originalValidUntil !== originalDeadline
      )
        return poison();
      const at = instant(now.call(clock));
      if (at < latest || at >= deadline) return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const read = async () => {
    check();
    const found = approval(await readPrivateJson(approvalPath));
    check();
    const current = trust(await readPrivateJson(trustPath)),
      at = check();
    if (
      !pinned ||
      canonicalizeRfc8785(
        expected(Object.fromEntries(expectedKeys.map((k) => [k, found[k as keyof typeof found]]))),
      ) !== canonicalizeRfc8785(pinned) ||
      found.notBefore > origin ||
      found.validUntil <= at ||
      current.withdrawnApprovalEvidenceReferences.includes(found.approvalEvidenceReference)
    )
      return poison();
    const key = current.keys.find((k) => k.keyReference === found.keyReference);
    if (
      !key ||
      key.approvedByReference !== found.approvedByReference ||
      canonicalizeRfc8785(key.configuration) !== canonicalizeRfc8785(found.configuration) ||
      key.notBefore > origin ||
      key.validUntil <= at
    )
      return poison();
    const parsed = createPublicKey({
      key: Buffer.from(key.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    if (
      parsed.asymmetricKeyType !== "ed25519" ||
      parsed.export({ format: "der", type: "spki" }).toString("base64url") !== key.publicKeySpki ||
      !verify(
        null,
        Buffer.from(workforceAccountBindingApprovalSigningBytes(found)),
        parsed,
        Buffer.from(found.signature, "base64url"),
      )
    )
      return poison();
    const actualBytes = canonicalizeRfc8785(found),
      actualKey = canonicalizeRfc8785(key);
    if (
      (approvalBytes !== undefined && approvalBytes !== actualBytes) ||
      (keyBytes !== undefined && keyBytes !== actualKey)
    )
      return poison();
    approvalBytes = actualBytes;
    keyBytes = actualKey;
    for (const until of [found.validUntil, key.validUntil]) if (until < deadline) deadline = until;
    check();
    return Object.freeze({
      operatorReference: found.operatorReference,
      approvedByReference: found.approvedByReference,
      approvalEvidenceReference: found.approvalEvidenceReference,
      validUntil: deadline,
    });
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || ++guardCalls !== 1) return poison();
    busy = true;
    try {
      await read();
      guarded = true;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const final = () => {
    if (busy || phase !== "Ready" || !guarded || guardCalls !== 1) return poison();
    check();
    phase = "Final";
  };
  return Object.freeze({
    async hold(value: WorkforceAccountBindingApprovalExpected) {
      if (busy) return poison();
      busy = true;
      try {
        if (!registered) {
          registered = true;
          if ((await register(tx, guard, final)) !== undefined) return poison();
        }
        check();
        const binding = expected(value);
        if (pinned && canonicalizeRfc8785(pinned) !== canonicalizeRfc8785(binding)) return poison();
        pinned = binding;
        const result = await read();
        phase = "Ready";
        return result;
      } catch {
        return poison();
      } finally {
        busy = false;
      }
    },
    assertFinalized() {
      if (phase !== "Final" || busy || !guarded || guardCalls !== 1) return poison();
    },
  });
}
