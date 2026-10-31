import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  GetUserPoolMfaConfigCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { BrowserSessionError } from "../contracts/browser-session.js";
import { parseCanonicalInstant, readClosedRecord } from "../contracts/identity-actor.js";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF (strong authentication with real Cognito): Amazon Cognito user
 * pool ID and access tokens carry `auth_time` but no `acr`/`amr`, so a token alone cannot prove the
 * password and authenticator (TOTP) were both used. That proof comes from the pool itself: MFA is
 * required (`MfaConfiguration: "ON"`), the authenticator app is the only second factor (no SMS or
 * email MFA), sign-in starts with a password only (no passkey/email/SMS one-time-password first
 * factor) and a remembered device can never skip MFA. Every login and step-up reads a check no
 * older than five minutes (refreshed on demand; the composition also refreshes it at startup and
 * every few minutes). Anything else (another setting, an error, no answer, a stale result) refuses
 * sign-in with `BROWSER_SESSION_UNAVAILABLE`; nothing is recorded.
 *
 * Needs `cognito-idp:GetUserPoolMfaConfig` and `cognito-idp:DescribeUserPool` on the pool.
 */
export type CognitoPoolMfaRefusal =
  | "MfaNotRequired"
  | "AuthenticatorAppNotEnabled"
  | "TextMessageMfaEnabled"
  | "EmailMfaEnabled"
  | "PasswordlessSignInAllowed"
  | "RememberedDevicesSkipMfa"
  | "Unavailable";
export interface CognitoPoolMfaStatus {
  readonly state: "Verified" | "Refused" | "Unknown";
  /** Why sign-in is refused (a setting name, never a secret); null when verified or unchecked. */
  readonly reason: CognitoPoolMfaRefusal | null;
  readonly checkedAt: string | null;
}
export interface CognitoPoolMfaPolicy {
  /** Resolves when the pool was verified within the maximum age (checking again if needed). */
  assertRequiredTotp(): Promise<void>;
  /** Checks the pool now; never throws. */
  refresh(): Promise<CognitoPoolMfaStatus>;
  status(): CognitoPoolMfaStatus;
  /**
   * Refreshes now and then every `intervalMs` (the timer does not keep the process alive), handing
   * each result to `onStatus`. Returns the stop.
   */
  monitor(intervalMs?: number, onStatus?: (status: CognitoPoolMfaStatus) => void): () => void;
}
export interface CognitoPoolMfaPolicyOptions {
  readonly userPoolId: string;
  readonly clock: { now(): string };
  readonly requestTimeoutMs?: number;
  /**
   * TEST-ONLY: a loopback Cognito stand-in (`http(s)://127.0.0.1:<port>/`) with its own static
   * credentials. The composition admits it only in the InternalTest environment.
   */
  readonly providerEndpoint?: {
    readonly url: string;
    readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  };
}
/** A verified check is used for at most this long. */
export const cognitoPoolMfaMaximumAgeMs = 300_000;
const defaultMonitorIntervalMs = 240_000;
const unavailable = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_UNAVAILABLE");
};
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const configured = (value: unknown) => value !== undefined && value !== null;

/** Pure verdict over the two admin answers (exported for tests). */
export function judgeCognitoPoolMfa(
  userPoolId: string,
  mfa: unknown,
  described: unknown,
): CognitoPoolMfaRefusal | null {
  const m = (mfa ?? {}) as {
    MfaConfiguration?: unknown;
    SoftwareTokenMfaConfiguration?: { Enabled?: unknown } | null;
    SmsMfaConfiguration?: unknown;
    EmailMfaConfiguration?: unknown;
  };
  const pool = ((described ?? {}) as { UserPool?: unknown }).UserPool as
    | {
        Id?: unknown;
        MfaConfiguration?: unknown;
        Policies?: { SignInPolicy?: { AllowedFirstAuthFactors?: unknown } | null } | null;
        DeviceConfiguration?: { ChallengeRequiredOnNewDevice?: unknown } | null;
      }
    | undefined;
  if (pool === undefined || pool === null || pool.Id !== userPoolId) return "Unavailable";
  if (m.MfaConfiguration !== "ON" || pool.MfaConfiguration !== "ON") return "MfaNotRequired";
  if (m.SoftwareTokenMfaConfiguration?.Enabled !== true) return "AuthenticatorAppNotEnabled";
  if (configured(m.SmsMfaConfiguration)) return "TextMessageMfaEnabled";
  if (configured(m.EmailMfaConfiguration)) return "EmailMfaEnabled";
  const first = pool.Policies?.SignInPolicy?.AllowedFirstAuthFactors;
  if (
    first !== undefined &&
    first !== null &&
    !(Array.isArray(first) && first.length === 1 && first[0] === "PASSWORD")
  )
    return "PasswordlessSignInAllowed";
  if (pool.DeviceConfiguration?.ChallengeRequiredOnNewDevice === true)
    return "RememberedDevicesSkipMfa";
  return null;
}

export function createCognitoPoolMfaPolicy(
  options: CognitoPoolMfaPolicyOptions,
): CognitoPoolMfaPolicy {
  try {
    readClosedRecord(options, [
      "userPoolId",
      "clock",
      ...(Object.hasOwn(options, "requestTimeoutMs") ? ["requestTimeoutMs"] : []),
      ...(Object.hasOwn(options, "providerEndpoint") ? ["providerEndpoint"] : []),
    ]);
    const pool = options.userPoolId,
      clock = options.clock,
      now = readClosedRecord(clock, ["now"]).now,
      timeout = options.requestTimeoutMs ?? 4000;
    if (
      typeof pool !== "string" ||
      !/^ca-central-1_[A-Za-z0-9]{1,42}$/u.test(pool) ||
      typeof now !== "function" ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 5000
    )
      return denied();
    const loopback = Object.hasOwn(options, "providerEndpoint")
      ? (() => {
          const value = readClosedRecord(options.providerEndpoint, ["url", "credentials"]);
          const secret = readClosedRecord(value.credentials, ["accessKeyId", "secretAccessKey"]);
          const url = typeof value.url === "string" ? new URL(value.url) : denied();
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.hostname !== "127.0.0.1" ||
            !url.port ||
            url.pathname !== "/" ||
            url.search ||
            url.hash ||
            typeof secret.accessKeyId !== "string" ||
            typeof secret.secretAccessKey !== "string"
          )
            return denied();
          return {
            endpoint: url.origin,
            credentials: {
              accessKeyId: secret.accessKeyId,
              secretAccessKey: secret.secretAccessKey,
            },
          };
        })()
      : null;
    const client = new CognitoIdentityProviderClient({
      region: "ca-central-1",
      endpoint: loopback?.endpoint ?? "https://cognito-idp.ca-central-1.amazonaws.com",
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: timeout, requestTimeout: timeout },
      ...(loopback === null ? {} : { credentials: { ...loopback.credentials } }),
    });
    const observe = () => Date.parse(parseCanonicalInstant(now.call(clock)));
    let current: CognitoPoolMfaStatus = Object.freeze({
      state: "Unknown",
      reason: null,
      checkedAt: null,
    });
    let inFlight: Promise<CognitoPoolMfaStatus> | null = null;
    const ask = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work(abort.signal),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new BrowserSessionError("BROWSER_SESSION_UNAVAILABLE"));
            }, timeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    };
    const check = async (): Promise<CognitoPoolMfaStatus> => {
      let startedAt: number;
      try {
        startedAt = observe();
      } catch {
        return current;
      }
      let reason: CognitoPoolMfaRefusal | null;
      try {
        const [mfa, described] = await Promise.all([
          ask((abortSignal) =>
            client.send(new GetUserPoolMfaConfigCommand({ UserPoolId: pool }), { abortSignal }),
          ),
          ask((abortSignal) =>
            client.send(new DescribeUserPoolCommand({ UserPoolId: pool }), { abortSignal }),
          ),
        ]);
        reason = judgeCognitoPoolMfa(pool, mfa, described);
      } catch {
        reason = "Unavailable";
      }
      // The verdict is dated when the check started, so it never outlives what was asked.
      current = Object.freeze({
        state: reason === null ? "Verified" : reason === "Unavailable" ? "Unknown" : "Refused",
        reason,
        checkedAt: new Date(startedAt).toISOString(),
      });
      return current;
    };
    const refresh = (): Promise<CognitoPoolMfaStatus> => {
      inFlight ??= check().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };
    const fresh = (status: CognitoPoolMfaStatus): boolean => {
      if (status.state !== "Verified" || status.checkedAt === null) return false;
      try {
        const at = observe(),
          checked = Date.parse(status.checkedAt);
        return at >= checked && at - checked < cognitoPoolMfaMaximumAgeMs;
      } catch {
        return false;
      }
    };
    return Object.freeze({
      async assertRequiredTotp() {
        if (fresh(current)) return;
        if (!fresh(await refresh())) unavailable();
      },
      refresh,
      status: () => current,
      monitor(
        intervalMs = defaultMonitorIntervalMs,
        onStatus: (status: CognitoPoolMfaStatus) => void = () => undefined,
      ) {
        if (
          !Number.isInteger(intervalMs) ||
          intervalMs < 1000 ||
          intervalMs > defaultMonitorIntervalMs ||
          typeof onStatus !== "function"
        )
          return denied();
        const run = () =>
          void refresh()
            .then(onStatus)
            .catch(() => undefined);
        run();
        const timer = setInterval(run, intervalMs);
        timer.unref?.();
        return () => clearInterval(timer);
      },
    });
  } catch (error) {
    if (error instanceof BrowserSessionError) throw error;
    return denied();
  }
}
