import { BrowserSessionError } from "../contracts/browser-session.js";
import { parseCanonicalInstant } from "../contracts/identity-actor.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
import {
  createCognitoPlatformProvider,
  type CognitoPlatformProviderOptions,
} from "./cognito-platform-provider.js";
import { createCognitoPlatformSubjectStatus } from "./cognito-platform-subject-status.js";
import {
  createPostgresPlatformActorDirectorySource,
  type PlatformActorDirectorySourceOptions,
  type PlatformActorDirectoryTransaction,
} from "./persistence/platform-actor-directory-store.js";

export interface CognitoPlatformIdentityOptions {
  readonly configuration: CognitoPlatformProviderOptions["configuration"] & {
    readonly environment: string;
  };
  readonly transactions: {
    run<T>(work: (tx: PlatformActorDirectoryTransaction) => Promise<T>): Promise<T>;
  };
  readonly registerBeforeCommit: PlatformActorDirectorySourceOptions["registerBeforeCommit"];
  readonly clock: { now(): string };
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly nextEvidenceReference: () => string;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};

/** Concrete Identity composition for the existing Platform Session store. Every
 * directory read belongs to the actual host transaction and its COMMIT guards.
 * Provider/directory verdicts are never configurable substitutes in this factory. */
export function createCognitoPlatformIdentity(options: CognitoPlatformIdentityOptions) {
  const { environment, ...providerConfiguration } = options.configuration;
  const configuration = Object.freeze({
    environment,
    issuer: providerConfiguration.issuer,
    clientIds: Object.freeze([providerConfiguration.clientId]),
  });
  const host = options.transactions,
    run = host.run,
    register = options.registerBeforeCommit,
    clock = options.clock,
    now = clock.now,
    hasher = options.hasher,
    envelopes = options.envelopes;
  if (
    [
      run,
      register,
      now,
      hasher?.hash,
      hasher?.equals,
      envelopes?.encrypt,
      envelopes?.decrypt,
      options.nextEvidenceReference,
    ].some((value) => typeof value !== "function")
  )
    return denied();
  const userPoolId =
    /^https:\/\/cognito-idp\.ca-central-1\.amazonaws\.com\/(ca-central-1_[A-Za-z0-9]{1,42})$/u.exec(
      configuration.issuer,
    )?.[1];
  if (!userPoolId || !/^[a-z][a-z0-9-]{0,63}$/u.test(environment)) return denied();
  const remote = createCognitoPlatformSubjectStatus({ userPoolId, clock });
  type Source = ReturnType<typeof createPostgresPlatformActorDirectorySource>;
  const active = new WeakMap<PlatformActorDirectoryTransaction, { source: Source | null }>();
  const observe = () => {
    if (
      options.transactions !== host ||
      host.run !== run ||
      options.registerBeforeCommit !== register ||
      options.clock !== clock ||
      clock.now !== now ||
      options.hasher !== hasher ||
      options.envelopes !== envelopes
    )
      return denied();
    return parseCanonicalInstant(now.call(clock));
  };
  const source = (tx: PlatformActorDirectoryTransaction, observedAt: string): Source => {
    observe();
    const entry = active.get(tx);
    if (!entry) return denied();
    if (!entry.source)
      entry.source = createPostgresPlatformActorDirectorySource({
        transaction: tx,
        configuration,
        clock,
        hasher,
        envelopes,
        originalObservedAt: observedAt,
        originalValidUntil: new Date(
          Date.parse(parseCanonicalInstant(observedAt)) + 5000,
        ).toISOString(),
        readCurrentProviderSubject: remote.readCurrentProviderSubject,
        registerBeforeCommit: register,
      });
    return entry.source;
  };
  const transactions = Object.freeze({
    async run<T>(work: (tx: PlatformActorDirectoryTransaction) => Promise<T>): Promise<T> {
      observe();
      let borrowed: PlatformActorDirectoryTransaction | null = null;
      let entry: { source: Source | null } | null = null;
      let invocations = 0;
      try {
        const result = (await run.call(host, async (tx) => {
          if (++invocations !== 1 || active.has(tx)) return denied();
          borrowed = tx;
          entry = { source: null };
          active.set(tx, entry);
          return work(tx);
        })) as T;
        if (invocations !== 1) return denied();
        // No post-COMMIT clock/provider query: only verify the owning final seal.
        const completed = entry as { source: Source | null } | null;
        completed?.source?.assertFinalized();
        return result;
      } finally {
        if (borrowed) active.delete(borrowed);
      }
    },
  });
  const provider = createCognitoPlatformProvider({
    configuration: providerConfiguration,
    clock,
    nextEvidenceReference: options.nextEvidenceReference,
    resolveVerifiedSubject: (input) =>
      transactions.run((tx) => source(tx, input.observedAt).resolveVerifiedSubject(input)),
  });
  return Object.freeze({
    provider,
    transactions,
    currentActor(
      tx: PlatformActorDirectoryTransaction,
      actorReference: string,
      authenticatedAt: string,
      observedAt: string,
    ) {
      return source(tx, observedAt).currentActor(tx, actorReference, authenticatedAt, observedAt);
    },
  });
}
