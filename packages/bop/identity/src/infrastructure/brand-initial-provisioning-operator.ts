import { canonicalizeRfc8785 } from "@bop/audit";
import { BrowserSessionError, parseRawBrowserCredential } from "../contracts/browser-session.js";
import {
  createIdentityActor,
  readClosedRecord,
  type IdentityActor,
} from "../contracts/identity-actor.js";
import {
  parsePlatformActorDirectoryConfiguration,
  parsePlatformActorDirectoryInstant,
  parsePlatformActorDirectoryReference,
} from "../contracts/platform-actor-directory.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
import type { OidcAuthorizationTransaction } from "./persistence/oidc-authorization-store.js";
import { createPostgresCurrentPlatformBrowserSessionSource } from "./persistence/current-platform-browser-session-source.js";
import { createPostgresPlatformActorDirectorySource } from "./persistence/platform-actor-directory-store.js";
import { createCognitoPlatformSubjectStatus } from "./cognito-platform-subject-status.js";

export interface BrandInitialProvisioningOperatorOptions {
  readonly transaction: OidcAuthorizationTransaction;
  readonly configuration: {
    readonly environment: string;
    readonly issuer: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly allowedPostLoginPaths: readonly string[];
  };
  readonly clock: { now(): string };
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly cookie: string;
  readonly actorReference: string;
  readonly registerBeforeCommit: (
    tx: OidcAuthorizationTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void>;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
/** Actual held Platform Session, directory and Cognito status only. The owning
 * Session proof supplies RecentMfa; this does not grant provisioning permission. */
export function createBrandInitialProvisioningOperatorSource(
  options: BrandInitialProvisioningOperatorOptions,
) {
  const raw = readClosedRecord(options, [
    "transaction",
    "configuration",
    "clock",
    "hasher",
    "envelopes",
    "originalObservedAt",
    "originalValidUntil",
    "cookie",
    "actorReference",
    "registerBeforeCommit",
  ]);
  readClosedRecord(options.clock, ["now"]);
  readClosedRecord(options.hasher, ["hash", "equals"]);
  readClosedRecord(options.envelopes, ["encrypt", "decrypt"]);
  const config = readClosedRecord(raw.configuration, [
      "environment",
      "issuer",
      "clientId",
      "redirectUri",
      "allowedPostLoginPaths",
    ]),
    tx = options.transaction,
    query = tx.query,
    clock = options.clock,
    now = clock.now,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    decrypt = envelopes.decrypt,
    register = options.registerBeforeCommit,
    configuration = options.configuration;
  const directoryConfiguration = parsePlatformActorDirectoryConfiguration({
      environment: config.environment,
      issuer: config.issuer,
      clientIds: [config.clientId],
    }),
    originalAt = parsePlatformActorDirectoryInstant(raw.originalObservedAt),
    originalUntil = parsePlatformActorDirectoryInstant(raw.originalValidUntil),
    cookie = parseRawBrowserCredential(raw.cookie),
    actorReference = parsePlatformActorDirectoryReference(raw.actorReference);
  if (
    originalAt >= originalUntil ||
    Date.parse(originalUntil) > Date.parse(originalAt) + 5000 ||
    [query, now, hash, equals, decrypt, register].some((p) => typeof p !== "function") ||
    typeof config.redirectUri !== "string" ||
    !Array.isArray(config.allowedPostLoginPaths)
  )
    return denied();
  const paths = config.allowedPostLoginPaths;
  if (
    !Array.isArray(paths) ||
    Object.getPrototypeOf(paths) !== Array.prototype ||
    paths.length > 32 ||
    Reflect.ownKeys(paths).length !== paths.length + 1
  )
    return denied();
  for (let i = 0; i < paths.length; i++) {
    const d = Object.getOwnPropertyDescriptor(paths, String(i));
    if (!d?.enumerable || !("value" in d) || typeof d.value !== "string") return denied();
  }
  const configBytes = canonicalizeRfc8785(config);
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    checked = false,
    asyncCalls = 0,
    finalCalls = 0,
    latest = originalAt,
    deadline = originalUntil,
    identity: string | undefined;
  const poison = (): never => {
    phase = "Poison";
    return denied();
  };
  const check = () => {
    try {
      readClosedRecord(options, [
        "transaction",
        "configuration",
        "clock",
        "hasher",
        "envelopes",
        "originalObservedAt",
        "originalValidUntil",
        "cookie",
        "actorReference",
        "registerBeforeCommit",
      ]);
      readClosedRecord(clock, ["now"]);
      readClosedRecord(hasher, ["hash", "equals"]);
      readClosedRecord(envelopes, ["encrypt", "decrypt"]);
      const currentConfig = readClosedRecord(configuration, [
          "environment",
          "issuer",
          "clientId",
          "redirectUri",
          "allowedPostLoginPaths",
        ]),
        currentPaths = currentConfig.allowedPostLoginPaths;
      if (
        !Array.isArray(currentPaths) ||
        Object.getPrototypeOf(currentPaths) !== Array.prototype ||
        currentPaths.length > 32 ||
        Reflect.ownKeys(currentPaths).length !== currentPaths.length + 1
      )
        return poison();
      for (let i = 0; i < currentPaths.length; i++) {
        const d = Object.getOwnPropertyDescriptor(currentPaths, String(i));
        if (!d?.enumerable || !("value" in d) || typeof d.value !== "string") return poison();
      }
      if (
        phase === "Poison" ||
        phase === "Final" ||
        options.transaction !== tx ||
        tx.query !== query ||
        options.configuration !== configuration ||
        canonicalizeRfc8785(currentConfig) !== configBytes ||
        options.clock !== clock ||
        clock.now !== now ||
        options.hasher !== hasher ||
        hasher.hash !== hash ||
        hasher.equals !== equals ||
        options.envelopes !== envelopes ||
        envelopes.decrypt !== decrypt ||
        options.originalObservedAt !== originalAt ||
        options.originalValidUntil !== originalUntil ||
        options.cookie !== cookie ||
        options.actorReference !== actorReference ||
        options.registerBeforeCommit !== register
      )
        return poison();
      const at = parsePlatformActorDirectoryInstant(now.call(clock));
      if (at < latest || at >= deadline) return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const pool = directoryConfiguration.issuer.slice(
    "https://cognito-idp.ca-central-1.amazonaws.com/".length,
  );
  const remote = createCognitoPlatformSubjectStatus({ userPoolId: pool, clock });
  const directory = createPostgresPlatformActorDirectorySource({
    transaction: tx,
    configuration: directoryConfiguration,
    clock,
    originalObservedAt: originalAt,
    originalValidUntil: originalUntil,
    hasher,
    envelopes,
    readCurrentProviderSubject: remote.readCurrentProviderSubject,
    registerBeforeCommit: async (actual, guard, final) => {
      check();
      if (actual !== tx) return poison();
      const result: unknown = await register(tx, guard, final);
      check();
      if (result !== undefined) return poison();
    },
  });
  const readSession = createPostgresCurrentPlatformBrowserSessionSource({
    environment: directoryConfiguration.environment,
    issuer: directoryConfiguration.issuer,
    clientId: configuration.clientId,
    redirectUri: configuration.redirectUri,
    allowedPostLoginPaths: configuration.allowedPostLoginPaths,
    now: check,
    currentActor: (actual, actor, authenticatedAt, observedAt) =>
      directory.currentActor(actual, actor, authenticatedAt, observedAt),
    hasher,
    envelopes,
  });
  const read = async (): Promise<{
    readonly actor: IdentityActor;
    readonly validUntil: string;
  }> => {
    check();
    const packet = await readSession(tx, cookie);
    check();
    if (
      packet.session.actor.actorReference !== actorReference ||
      packet.recentMfa.actorReference !== actorReference ||
      packet.recentMfa.sessionReference !== packet.session.sessionReference
    )
      return poison();
    const actor = createIdentityActor({
      ...packet.session.actor,
      verificationLevel: "RecentMfa",
      recentMfaAt: packet.recentMfa.verifiedAt,
    });
    const bytes = canonicalizeRfc8785({
      session: packet.session,
      recentMfa: packet.recentMfa,
      actor,
    });
    if (identity !== undefined && identity !== bytes) return poison();
    identity = bytes;
    if (packet.validUntil < deadline) deadline = packet.validUntil;
    const mfaUntil = new Date(Date.parse(packet.recentMfa.verifiedAt) + 900000).toISOString();
    if (mfaUntil < deadline) deadline = mfaUntil;
    check();
    phase = "Ready";
    return Object.freeze({ actor, validUntil: deadline });
  };
  return Object.freeze({
    async hold() {
      try {
        if (busy) return poison();
        busy = true;
        if (!registered) {
          registered = true;
          const result: unknown = await register(
            tx,
            async () => {
              try {
                if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
                busy = true;
                await read();
                checked = true;
              } catch {
                return poison();
              } finally {
                busy = false;
              }
            },
            () => {
              if (busy || phase !== "Ready" || !checked || asyncCalls !== 1 || ++finalCalls !== 1)
                return poison();
              check();
              phase = "Final";
            },
          );
          if (result !== undefined) return poison();
        }
        return await read();
      } catch {
        return poison();
      } finally {
        busy = false;
      }
    },
    assertFinalized(): void {
      if (phase !== "Final" || busy || !checked || asyncCalls !== 1 || finalCalls !== 1)
        return poison();
      directory.assertFinalized();
    },
  });
}
