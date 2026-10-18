import { BrowserSessionError } from "../contracts/browser-session.js";
import { parseCanonicalInstant, readClosedRecord } from "../contracts/identity-actor.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
import {
  createCognitoWorkforceProvider,
  type CognitoWorkforceProviderOptions,
} from "./cognito-workforce-provider.js";
import {
  createPostgresWorkforceAuthenticationSource,
  type WorkforceAuthenticationSourceOptions,
} from "./persistence/workforce-authentication-source.js";
import type { CurrentWorkforceAccountTransaction } from "./persistence/current-workforce-account-source.js";

export interface CognitoWorkforceIdentityOptions {
  readonly configuration: CognitoWorkforceProviderOptions["configuration"] & {
    readonly environment: string;
  };
  readonly transactions: {
    run<T>(work: (tx: CurrentWorkforceAccountTransaction) => Promise<T>): Promise<T>;
  };
  /** Must register on the genuine live host for this exact transaction, including
   * independently wrapped API transactions. It must reject foreign/closed handles. */
  readonly registerBeforeCommit: WorkforceAuthenticationSourceOptions["registerBeforeCommit"];
  readonly clock: { now(): string };
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly nextEvidenceReference: () => string;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const configurationKeys = [
  "environment",
  "issuer",
  "clientId",
  "clientSecret",
  "managedLoginOrigin",
  "redirectUri",
  "logoutReturnUri",
] as const;
type Transaction = CurrentWorkforceAccountTransaction;
type Source = ReturnType<typeof createPostgresWorkforceAuthenticationSource>;
interface Entry {
  phase: "Open" | "Final" | "Poison";
  source: Source | null;
  observedAt: string | null;
  validUntil: string | null;
  latest: string | null;
  readonly query: Transaction["query"];
  asynchronous: boolean;
  sealed: boolean;
}

/** Concrete Workforce Identity only. The signed Provider result supplies login
 * and TOTP facts; the account reader supplies the existing SingleFactor Actor.
 * Every owning or borrowed read belongs to an actual host COMMIT guard. */
export function createCognitoWorkforceIdentity(options: CognitoWorkforceIdentityOptions) {
  readClosedRecord(options, [
    "configuration",
    "transactions",
    "registerBeforeCommit",
    "clock",
    "hasher",
    "envelopes",
    "nextEvidenceReference",
  ]);
  const originalConfiguration = options.configuration,
    configured = readClosedRecord(originalConfiguration, configurationKeys),
    { environment, ...providerConfiguration } = options.configuration,
    configuration = Object.freeze({
      environment,
      issuer: providerConfiguration.issuer,
      clientIds: Object.freeze([providerConfiguration.clientId]),
    }),
    host = options.transactions,
    run = host.run,
    register = options.registerBeforeCommit,
    clock = options.clock,
    now = clock.now,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    encrypt = envelopes.encrypt,
    decrypt = envelopes.decrypt,
    next = options.nextEvidenceReference;
  if (
    !/^[a-z][a-z0-9-]{0,63}$/u.test(environment) ||
    [run, register, now, hash, equals, encrypt, decrypt, next].some(
      (port) => typeof port !== "function",
    )
  )
    return denied();
  const entries = new WeakMap<Transaction, Entry>(),
    pending = new WeakMap<Transaction, Entry>();
  const poison = (entry: Entry): never => {
    entry.phase = "Poison";
    return denied();
  };
  const observe = () => {
    const current = readClosedRecord(options.configuration, configurationKeys);
    if (
      options.configuration !== originalConfiguration ||
      configurationKeys.some((key) => current[key] !== configured[key]) ||
      options.transactions !== host ||
      host.run !== run ||
      options.registerBeforeCommit !== register ||
      options.clock !== clock ||
      clock.now !== now ||
      options.hasher !== hasher ||
      hasher.hash !== hash ||
      hasher.equals !== equals ||
      options.envelopes !== envelopes ||
      envelopes.encrypt !== encrypt ||
      envelopes.decrypt !== decrypt ||
      options.nextEvidenceReference !== next
    )
      return denied();
    const at = parseCanonicalInstant(now.call(clock));
    if (at.startsWith("0000-")) return denied();
    return at;
  };
  const check = (tx: Transaction, entry: Entry) => {
    try {
      const at = observe();
      if (
        entry.phase !== "Open" ||
        tx.query !== entry.query ||
        entry.latest === null ||
        entry.validUntil === null ||
        at < entry.latest ||
        at >= entry.validUntil
      )
        return poison(entry);
      entry.latest = at;
      return at;
    } catch {
      return poison(entry);
    }
  };
  const admit = async (tx: Transaction, original?: string): Promise<Entry> => {
    const existing = entries.get(tx) ?? pending.get(tx);
    if (existing) {
      if (pending.has(tx)) return poison(existing);
      check(tx, existing);
      return existing;
    }
    const entry: Entry = {
      phase: "Open",
      source: null,
      observedAt: null,
      validUntil: null,
      latest: null,
      query: tx.query,
      asynchronous: false,
      sealed: false,
    };
    pending.set(tx, entry);
    try {
      // Admission precedes constructor/preflight failures and every owning query.
      // A caught failure must still make the real host refuse COMMIT.
      await register.call(
        options,
        tx,
        async () => {
          if (entry.asynchronous || entry.sealed) return poison(entry);
          check(tx, entry);
          entry.asynchronous = true;
        },
        () => {
          if (!entry.asynchronous || entry.sealed) return poison(entry);
          check(tx, entry);
          entry.sealed = true;
          entry.phase = "Final";
        },
      );
      if (entry.phase !== "Open" || typeof entry.query !== "function") return poison(entry);
      const current = observe(),
        observedAt = original === undefined ? current : parseCanonicalInstant(original),
        validUntil = parseCanonicalInstant(new Date(Date.parse(observedAt) + 5000).toISOString());
      if (observedAt.startsWith("0000-") || observedAt > current) return poison(entry);
      entry.observedAt = observedAt;
      entry.validUntil = validUntil;
      entry.latest = observedAt;
      check(tx, entry);
      entries.set(tx, entry);
      return entry;
    } catch {
      return poison(entry);
    } finally {
      pending.delete(tx);
    }
  };
  const withSource = async <T>(
    tx: Transaction,
    at: string,
    work: (source: Source) => Promise<T>,
  ): Promise<T> => {
    const entry = await admit(tx, at);
    try {
      check(tx, entry);
      if (!entry.source) {
        if (entry.observedAt === null || entry.validUntil === null) return poison(entry);
        const requestedAt = parseCanonicalInstant(at),
          sourceAt = requestedAt < entry.observedAt ? requestedAt : entry.observedAt,
          sourceUntil = parseCanonicalInstant(new Date(Date.parse(sourceAt) + 5000).toISOString());
        entry.source = createPostgresWorkforceAuthenticationSource({
          transaction: tx,
          configuration,
          clock,
          hasher,
          envelopes,
          originalObservedAt: sourceAt,
          originalValidUntil: sourceUntil < entry.validUntil ? sourceUntil : entry.validUntil,
          async registerBeforeCommit(actual, guard, final) {
            if (actual !== tx) return poison(entry);
            check(tx, entry);
            await register.call(options, actual, guard, final);
            check(tx, entry);
          },
        });
      }
      const result = await work(entry.source);
      check(tx, entry);
      return result;
    } catch {
      return poison(entry);
    }
  };
  const transactions = Object.freeze({
    async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      const operation: { invocations: number; entry: Entry | null } = {
        invocations: 0,
        entry: null,
      };
      try {
        if (typeof work !== "function") return denied();
        const result = await run.call(host, async (tx) => {
          if (++operation.invocations !== 1 || entries.has(tx) || pending.has(tx)) {
            if (operation.entry) operation.entry.phase = "Poison";
            return denied();
          }
          const entry = await admit(tx);
          operation.entry = entry;
          try {
            const value = await work(tx);
            check(tx, entry);
            return value;
          } catch {
            return poison(entry);
          }
        });
        const entry = operation.entry;
        if (
          operation.invocations !== 1 ||
          !entry ||
          entry.phase !== "Final" ||
          !entry.asynchronous ||
          !entry.sealed
        )
          return denied();
        // The real runner has committed. This is deliberately a pure state check:
        // a delayed reply cannot invalidate a successfully committed transaction.
        entry.source?.assertFinalized();
        return result as T;
      } catch {
        if (operation.entry) operation.entry.phase = "Poison";
        return denied();
      }
    },
  });
  const provider = createCognitoWorkforceProvider({
    configuration: Object.freeze(providerConfiguration),
    clock,
    nextEvidenceReference: next,
    resolveVerifiedSubject: (input) =>
      transactions.run((tx) =>
        withSource(tx, input.observedAt, (source) => source.resolveVerifiedSubject(input)),
      ),
  });
  return Object.freeze({
    provider,
    transactions,
    currentActor(
      tx: Transaction,
      actorReference: string,
      authenticatedAt: string,
      observedAt: string,
    ) {
      return withSource(tx, observedAt, (source) =>
        source.currentActor(tx, actorReference, authenticatedAt, observedAt),
      );
    },
  });
}
