import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { TextDecoder } from "node:util";
import { readClosedRecord } from "@bop/identity";
import {
  parseWorkforceRelationshipQualification,
  parseWorkforceRelationshipQualificationExpected,
  parseWorkforceRelationshipQualificationInstant,
  parseWorkforceRelationshipQualificationTrust,
  workforceRelationshipQualificationSigningBytes,
  WorkforceRelationshipQualificationError,
  type WorkforceRelationshipQualificationExpected,
} from "../contracts/workforce-relationship-qualification.js";

export interface WorkforceRelationshipQualificationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface WorkforceRelationshipQualificationAuthority {
  readonly expected: WorkforceRelationshipQualificationExpected;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface FileCurrentWorkforceRelationshipSourceOptions {
  readonly transaction: WorkforceRelationshipQualificationTransaction;
  readonly expected: WorkforceRelationshipQualificationExpected;
  readonly qualificationPath: string;
  readonly trustPath: string;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  /** Current caller authorization for this exact scoped evidence read. Neither
   * this port nor the plan approver can replace the external issuer's signature. */
  readonly authority: {
    hold(
      tx: WorkforceRelationshipQualificationTransaction,
      input: WorkforceRelationshipQualificationAuthority,
    ): Promise<WorkforceRelationshipQualificationAuthority>;
  };
  readonly registerBeforeCommit: (
    tx: WorkforceRelationshipQualificationTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface CurrentWorkforceRelationshipQualification extends WorkforceRelationshipQualificationExpected {
  readonly profile: "CurrentWorkforceRelationshipQualificationV1";
  readonly issuerReference: string;
  readonly revision: number;
  readonly relationshipEffectiveFrom: string;
  readonly relationshipEffectiveUntil: string | null;
  readonly verifiedAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface CurrentWorkforceRelationshipSource {
  hold(): Promise<CurrentWorkforceRelationshipQualification>;
  assertFinalized(): void;
}
const fail = (): never => {
  throw new WorkforceRelationshipQualificationError();
};
function path(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value
  )
    return fail();
  return value;
}
async function readPrivateJson(file: string): Promise<unknown> {
  if (typeof process.getuid !== "function") return fail();
  const uid = process.getuid();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true }),
      mode = before.mode & 0o7777n;
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      (mode !== 0o600n && mode !== 0o400n) ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > 65_536n
    )
      return fail();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const after = await handle.stat({ bigint: true }),
      current = await lstat(file, { bigint: true });
    for (const stat of [after, current]) {
      if (
        !stat.isFile() ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.size !== before.size ||
        stat.uid !== before.uid ||
        stat.mode !== before.mode ||
        stat.nlink !== before.nlink ||
        stat.mtimeNs !== before.mtimeNs ||
        stat.ctimeNs !== before.ctimeNs
      )
        return fail();
    }
    if (total !== Number(before.size)) return fail();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)));
  } catch {
    return fail();
  } finally {
    if (handle) await handle.close().catch(fail);
  }
}
const optionKeys = [
  "transaction",
  "expected",
  "qualificationPath",
  "trustPath",
  "clock",
  "originalObservedAt",
  "originalValidUntil",
  "authority",
  "registerBeforeCommit",
];

/** A concrete read-only transport for separately verified external facts. No
 * built-in issuer, signing key, HR decision, Membership or permission is created.
 * Fixed private deployment paths must never come from an ordinary request. The
 * caller retains the actual transaction through both guards and COMMIT. */
export function createFileCurrentWorkforceRelationshipSource(
  options: FileCurrentWorkforceRelationshipSourceOptions,
): CurrentWorkforceRelationshipSource {
  readClosedRecord(options, optionKeys);
  readClosedRecord(options.clock, ["now"]);
  readClosedRecord(options.authority, ["hold"]);
  const tx = options.transaction,
    originalQuery = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    authorize = authority.hold,
    register = options.registerBeforeCommit,
    expected = parseWorkforceRelationshipQualificationExpected(options.expected),
    expectedBytes = JSON.stringify(expected),
    qualificationPath = path(options.qualificationPath),
    trustPath = path(options.trustPath),
    observedAt = parseWorkforceRelationshipQualificationInstant(options.originalObservedAt),
    originalDeadline = parseWorkforceRelationshipQualificationInstant(options.originalValidUntil);
  if (
    qualificationPath === trustPath ||
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [originalQuery, now, authorize, register].some((p) => typeof p !== "function")
  )
    return fail();
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    asyncCalls = 0,
    finalCalls = 0,
    asyncComplete = false,
    latest = observedAt,
    deadline = originalDeadline,
    statementIdentity: string | undefined,
    keyIdentity: string | undefined;
  const poison = (): never => {
    phase = "Poison";
    return fail();
  };
  const check = () => {
    try {
      readClosedRecord(options, optionKeys);
      readClosedRecord(clock, ["now"]);
      readClosedRecord(authority, ["hold"]);
      if (
        phase === "Poison" ||
        phase === "Final" ||
        options.transaction !== tx ||
        tx.query !== originalQuery ||
        options.clock !== clock ||
        clock.now !== now ||
        options.authority !== authority ||
        authority.hold !== authorize ||
        options.registerBeforeCommit !== register ||
        options.qualificationPath !== qualificationPath ||
        options.trustPath !== trustPath ||
        options.originalObservedAt !== observedAt ||
        options.originalValidUntil !== originalDeadline ||
        JSON.stringify(parseWorkforceRelationshipQualificationExpected(options.expected)) !==
          expectedBytes
      )
        return poison();
      const at = parseWorkforceRelationshipQualificationInstant(now.call(clock));
      if (at < latest || at >= deadline) return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const currentAuthority = async () => {
    const at = check(),
      limit = deadline;
    const r = readClosedRecord(
      await authorize.call(
        authority,
        tx,
        Object.freeze({ expected, observedAt: at, validUntil: limit }),
      ),
      ["expected", "observedAt", "validUntil"],
    );
    check();
    const until = parseWorkforceRelationshipQualificationInstant(r.validUntil);
    if (
      JSON.stringify(parseWorkforceRelationshipQualificationExpected(r.expected)) !==
        expectedBytes ||
      r.observedAt !== at ||
      until > limit ||
      until <= latest
    )
      return poison();
    deadline = until;
  };
  const read = async (): Promise<CurrentWorkforceRelationshipQualification> => {
    await currentAuthority();
    const statement = parseWorkforceRelationshipQualification(
      await readPrivateJson(qualificationPath),
    );
    check();
    const trust = parseWorkforceRelationshipQualificationTrust(await readPrivateJson(trustPath)),
      at = check();
    if (
      statement.environmentReference !== expected.environmentReference ||
      statement.actorReference !== expected.actorReference ||
      statement.brandReference !== expected.brandReference ||
      statement.workforceRelationshipReference !== expected.workforceRelationshipReference ||
      statement.relationshipEvidenceReference !== expected.relationshipEvidenceReference ||
      statement.status !== "Current" ||
      statement.verifiedAt > observedAt ||
      statement.effectiveFrom > observedAt ||
      statement.validUntil <= at ||
      (statement.effectiveUntil !== null && statement.effectiveUntil <= at) ||
      trust.withdrawnEvidenceReferences.includes(statement.relationshipEvidenceReference)
    )
      return poison();
    const key = trust.keys.find((item) => item.keyReference === statement.keyReference);
    if (
      !key ||
      key.environmentReference !== expected.environmentReference ||
      key.issuerReference !== statement.issuerReference ||
      !key.brandReferences.includes(expected.brandReference) ||
      key.notBefore > statement.verifiedAt ||
      key.notBefore > at ||
      key.validUntil <= at
    )
      return poison();
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      publicKey.export({ format: "der", type: "spki" }).toString("base64url") !==
        key.publicKeySpki ||
      !verify(
        null,
        Buffer.from(workforceRelationshipQualificationSigningBytes(statement), "utf8"),
        publicKey,
        Buffer.from(statement.signature, "base64url"),
      )
    )
      return poison();
    const statementBytes = JSON.stringify(statement),
      keyBytes = JSON.stringify(key);
    if (
      (statementIdentity !== undefined && statementIdentity !== statementBytes) ||
      (keyIdentity !== undefined && keyIdentity !== keyBytes)
    )
      return poison();
    statementIdentity = statementBytes;
    keyIdentity = keyBytes;
    for (const until of [statement.validUntil, key.validUntil, statement.effectiveUntil])
      if (until !== null && until < deadline) deadline = until;
    check();
    await currentAuthority();
    check();
    return Object.freeze({
      profile: "CurrentWorkforceRelationshipQualificationV1",
      ...expected,
      issuerReference: statement.issuerReference,
      revision: statement.revision,
      relationshipEffectiveFrom: statement.effectiveFrom,
      relationshipEffectiveUntil: statement.effectiveUntil,
      verifiedAt: statement.verifiedAt,
      observedAt,
      validUntil: deadline,
    });
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
    busy = true;
    try {
      await read();
      check();
      asyncComplete = true;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const final = () => {
    try {
      if (busy || phase !== "Ready" || !asyncComplete || ++finalCalls !== 1) return poison();
      check();
      phase = "Final";
    } catch {
      return poison();
    }
  };
  return Object.freeze({
    async hold() {
      if (busy || phase === "Final") return poison();
      busy = true;
      try {
        if (!registered) {
          registered = true;
          await register(tx, guard, final);
        }
        check();
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
      if (phase !== "Final" || busy || asyncCalls !== 1 || finalCalls !== 1 || !asyncComplete)
        return poison();
    },
  });
}
