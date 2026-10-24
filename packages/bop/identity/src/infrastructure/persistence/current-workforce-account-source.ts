import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../../application/ports/session-credential-ports.js";
import type { CurrentWorkforceAccount } from "../../contracts/current-workforce-account.js";
import type { WorkforceAccountBindingConfiguration } from "../../contracts/workforce-account-binding.js";
import { createWorkforceAccountReadKernel } from "./workforce-account-read-kernel.js";

export interface CurrentWorkforceAccountTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface CurrentWorkforceAccountAuthority {
  readonly actorReference: string;
  readonly purposeCode: "BRAND_INITIAL_PROVISIONING";
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface CurrentWorkforceAccountSourceOptions {
  readonly transaction: CurrentWorkforceAccountTransaction;
  readonly configuration: WorkforceAccountBindingConfiguration;
  readonly actorReference: string;
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  /** Holds the actual caller's current authority to read this exact target
   * account. An immutable subject mapping is not itself caller permission. */
  readonly authority: {
    hold(
      tx: CurrentWorkforceAccountTransaction,
      input: CurrentWorkforceAccountAuthority,
    ): Promise<CurrentWorkforceAccountAuthority>;
  };
  readonly registerBeforeCommit: (
    tx: CurrentWorkforceAccountTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface CurrentWorkforceAccountSource {
  hold(): Promise<CurrentWorkforceAccount>;
  /** Pure post-COMMIT state assertion. Both host guards must have run. */
  assertFinalized(): void;
}

/** Fixed initial-provisioning account facts. The required current caller
 * authority, original observation and public account-only result are unchanged. */
export function createPostgresCurrentWorkforceAccountSource(
  options: CurrentWorkforceAccountSourceOptions,
): CurrentWorkforceAccountSource {
  const reader = createWorkforceAccountReadKernel({ kind: "InitialProvisioning", options });
  return Object.freeze({ hold: reader.holdAccount, assertFinalized: reader.assertFinalized });
}
