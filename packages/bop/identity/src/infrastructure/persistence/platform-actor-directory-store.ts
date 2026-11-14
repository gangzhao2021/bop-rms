import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createIdentityActor,
  parseCanonicalInstant,
  type IdentityActor,
} from "../../contracts/identity-actor.js";
import {
  parseRawBrowserCredential,
  parseSelectorHash,
  type SelectorHash,
} from "../../contracts/browser-session.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../../application/ports/session-credential-ports.js";
import {
  parsePlatformActorDirectoryConfiguration,
  parsePlatformActorDirectoryInstant,
  parsePlatformActorDirectoryReference,
  parsePlatformActorDirectoryRevision,
  parsePlatformActorDirectorySubject,
  platformActorDirectoryClosed,
  platformActorDirectoryFail,
  platformActorSubjectContext,
  PlatformActorDirectoryError,
  type PlatformActorDirectoryConfiguration,
  type PlatformActorDirectoryProviderObservation,
  type PlatformActorDirectorySubjectRequest,
} from "../../contracts/platform-actor-directory.js";
export interface PlatformActorDirectoryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface PlatformActorDirectorySourceOptions {
  readonly transaction: PlatformActorDirectoryTransaction;
  readonly configuration: PlatformActorDirectoryConfiguration;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly readCurrentProviderSubject: (input: {
    readonly issuer: string;
    readonly subject: string;
    readonly observedAt: string;
  }) => Promise<PlatformActorDirectoryProviderObservation>;
  readonly registerBeforeCommit: (
    tx: PlatformActorDirectoryTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export const platformActorDirectoryCodec = Object.freeze({
  canonicalize: canonicalizeRfc8785,
  hash: sha256Hex,
});
export function platformActorDirectorySubjectHash(
  hasher: BrowserCredentialHasherPort,
  configuration: PlatformActorDirectoryConfiguration,
  subject: string,
): SelectorHash {
  const preimage = canonicalizeRfc8785({
    environment: configuration.environment,
    issuer: configuration.issuer,
    subject: parsePlatformActorDirectorySubject(subject),
  });
  return parseSelectorHash(
    hasher.hash(
      parseRawBrowserCredential(Buffer.from(sha256Hex(preimage), "hex").toString("base64url")),
    ),
  );
}
export function platformActorDirectoryOne(value: unknown): Record<string, unknown> | null {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > 1 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE");
  if (!d.value.length) return null;
  const row = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!row?.enumerable || !("value" in row) || !row.value || typeof row.value !== "object")
    return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE");
  return row.value as Record<string, unknown>;
}
export function createPostgresPlatformActorDirectorySource(
  options: PlatformActorDirectorySourceOptions,
) {
  const configuration = parsePlatformActorDirectoryConfiguration(options.configuration),
    tx = options.transaction,
    originalQuery = tx.query,
    clock = options.clock,
    now = clock.now,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    decrypt = envelopes.decrypt,
    provider = options.readCurrentProviderSubject,
    register = options.registerBeforeCommit;
  const observedAt = parsePlatformActorDirectoryInstant(options.originalObservedAt),
    originalDeadline = parsePlatformActorDirectoryInstant(options.originalValidUntil);
  if (
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [originalQuery, now, hash, equals, decrypt, provider, register].some(
      (p) => typeof p !== "function",
    )
  )
    return platformActorDirectoryFail();
  let latest = observedAt,
    deadline = originalDeadline,
    phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    asyncCalls = 0,
    finalCalls = 0,
    asyncComplete = false;
  const held = new Map<string, { bytes: string; subject: string; authenticatedAt: string }>();
  const poison = (): never => {
    phase = "Poison";
    return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE");
  };
  const check = () => {
    const at = parsePlatformActorDirectoryInstant(now.call(clock));
    if (
      phase === "Poison" ||
      phase === "Final" ||
      options.transaction !== tx ||
      tx.query !== originalQuery ||
      options.clock !== clock ||
      clock.now !== now ||
      options.hasher !== hasher ||
      hasher.hash !== hash ||
      hasher.equals !== equals ||
      options.envelopes !== envelopes ||
      envelopes.decrypt !== decrypt ||
      options.readCurrentProviderSubject !== provider ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== observedAt ||
      options.originalValidUntil !== originalDeadline ||
      canonicalizeRfc8785(parsePlatformActorDirectoryConfiguration(options.configuration)) !==
        canonicalizeRfc8785(configuration) ||
      at < latest ||
      at >= deadline
    )
      return poison();
    latest = at;
    return at;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    try {
      const result = await originalQuery.call(tx, sql, values);
      check();
      return result;
    } catch {
      return poison();
    }
  };
  const load = async (actor: string | null, subjectHash: string | null) => {
    await query(
      "SELECT set_config('bop.platform_directory_environment',$1,true),set_config('bop.platform_directory_issuer',$2,true),set_config('bop.platform_directory_actor_id',$3,true),set_config('bop.platform_directory_subject_hash',$4,true)",
      [configuration.environment, configuration.issuer, actor ?? "", subjectHash ?? ""],
    );
    const isolation = platformActorDirectoryOne(
      await query("SELECT current_setting('transaction_isolation') AS isolation", []),
    );
    if (
      !isolation ||
      platformActorDirectoryClosed(isolation, ["isolation"]).isolation !== "read committed"
    )
      return poison();
    const row = platformActorDirectoryOne(
      await query("SELECT * FROM bop_identity.platform_actor_directory_read($1,$2,$3,$4)", [
        actor,
        subjectHash,
        configuration.issuer,
        configuration.environment,
      ]),
    );
    if (!row) return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_DENIED");
    const r = platformActorDirectoryClosed(row, ["snapshot_text", "source_digest", "coherent"]);
    if (
      typeof r.snapshot_text !== "string" ||
      r.snapshot_text.length > 32768 ||
      r.coherent !== true
    )
      return poison();
    const revision = parsePlatformActorDirectoryRevision(
      JSON.parse(r.snapshot_text),
      platformActorDirectoryCodec,
    );
    if (
      canonicalizeRfc8785(revision) !== r.snapshot_text ||
      r.source_digest !== revision.sourceDigest ||
      canonicalizeRfc8785(revision.configuration) !== canonicalizeRfc8785(configuration) ||
      revision.recordedAt > check() ||
      (actor !== null && revision.actorReference !== actor) ||
      (subjectHash !== null && revision.subjectHash !== subjectHash)
    )
      return poison();
    if (revision.status !== "Active")
      return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_DENIED");
    return { revision, bytes: r.snapshot_text };
  };
  const status = async (subject: string) => {
    const r = platformActorDirectoryClosed(
      await provider({ issuer: configuration.issuer, subject, observedAt: check() }),
      ["issuer", "subject", "status", "observedAt", "validUntil"],
    );
    check();
    const seen = parsePlatformActorDirectoryInstant(r.observedAt),
      until = parsePlatformActorDirectoryInstant(r.validUntil);
    if (
      r.issuer !== configuration.issuer ||
      r.subject !== subject ||
      r.status !== "Enabled" ||
      seen > latest ||
      seen < observedAt ||
      until <= latest ||
      Date.parse(until) > Date.parse(seen) + 5000
    )
      return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_DENIED");
    deadline = [deadline, until].sort()[0] ?? deadline;
    check();
  };
  const resolve = async (
    actor: string | null,
    subject: string | null,
    authenticatedAt: string,
  ): Promise<IdentityActor> => {
    if (busy || phase === "Final") return poison();
    busy = true;
    try {
      check();
      authenticatedAt = parsePlatformActorDirectoryInstant(authenticatedAt);
      if (authenticatedAt > latest) return poison();
      const subjectHash =
          subject === null
            ? null
            : platformActorDirectorySubjectHash(hasher, configuration, subject),
        loaded = await load(actor, subjectHash);
      const plaintext = await decrypt.call(
        envelopes,
        loaded.revision.encryptedSubject,
        platformActorSubjectContext(configuration, loaded.revision.actorReference),
      );
      check();
      if (typeof plaintext !== "string" || plaintext.length > 1024) return poison();
      const packet = platformActorDirectoryClosed(JSON.parse(plaintext), ["subject"]),
        actualSubject = parsePlatformActorDirectorySubject(packet.subject);
      if (
        (subject !== null && actualSubject !== subject) ||
        !equals.call(
          hasher,
          platformActorDirectorySubjectHash(hasher, configuration, actualSubject),
          loaded.revision.subjectHash,
        )
      )
        return poison();
      await status(actualSubject);
      const prior = held.get(loaded.revision.actorReference);
      if (prior && prior.bytes !== loaded.bytes) return poison();
      held.set(loaded.revision.actorReference, {
        bytes: loaded.bytes,
        subject: actualSubject,
        authenticatedAt,
      });
      phase = "Ready";
      if (!registered) {
        registered = true;
        if (
          (await register(
            tx,
            async () => {
              if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
              busy = true;
              try {
                for (const [ref, pinned] of held) {
                  if ((await load(ref, null)).bytes !== pinned.bytes) return poison();
                  await status(pinned.subject);
                }
                check();
                asyncComplete = true;
              } catch {
                return poison();
              } finally {
                busy = false;
              }
            },
            () => {
              if (
                busy ||
                phase !== "Ready" ||
                !asyncComplete ||
                asyncCalls !== 1 ||
                ++finalCalls !== 1
              )
                return poison();
              check();
              phase = "Final";
            },
          )) !== undefined
        )
          return poison();
        check();
      }
      return createIdentityActor({
        actorType: "User",
        actorReference: loaded.revision.actorReference,
        accountKind: "Platform",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: parseCanonicalInstant(authenticatedAt),
        recentMfaAt: null,
      });
    } catch (error) {
      phase = "Poison";
      if (error instanceof PlatformActorDirectoryError) throw error;
      return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE");
    } finally {
      busy = false;
    }
  };
  return Object.freeze({
    async currentActor(
      actual: PlatformActorDirectoryTransaction,
      actorReference: string,
      authenticatedAt: string,
      at: string,
    ): Promise<IdentityActor> {
      try {
        if (
          actual !== tx ||
          parsePlatformActorDirectoryInstant(at) < observedAt ||
          parsePlatformActorDirectoryInstant(at) > check()
        )
          return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_DENIED");
        return await resolve(
          parsePlatformActorDirectoryReference(actorReference),
          null,
          authenticatedAt,
        );
      } catch (error) {
        phase = "Poison";
        throw error;
      }
    },
    async resolveVerifiedSubject(
      input: PlatformActorDirectorySubjectRequest,
    ): Promise<IdentityActor> {
      try {
        const r = platformActorDirectoryClosed(input, [
          "issuer",
          "clientId",
          "subject",
          "authenticatedAt",
          "observedAt",
        ]);
        if (
          r.issuer !== configuration.issuer ||
          typeof r.clientId !== "string" ||
          !configuration.clientIds.includes(r.clientId) ||
          parsePlatformActorDirectoryInstant(r.observedAt) < observedAt ||
          parsePlatformActorDirectoryInstant(r.observedAt) > check()
        )
          return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_DENIED");
        return await resolve(
          null,
          parsePlatformActorDirectorySubject(r.subject),
          parsePlatformActorDirectoryInstant(r.authenticatedAt),
        );
      } catch (error) {
        phase = "Poison";
        throw error;
      }
    },
    assertFinalized(): void {
      if (phase !== "Final" || !asyncComplete || asyncCalls !== 1 || finalCalls !== 1 || busy)
        return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE");
    },
  });
}
