import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { BrowserSessionError } from "../contracts/browser-session.js";
import { parseCanonicalInstant, readClosedRecord } from "../contracts/identity-actor.js";

export interface CognitoSubjectStatusOptions {
  readonly userPoolId: string;
  readonly clock: { now(): string };
  readonly requestTimeoutMs?: number;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};

/** Current local Cognito account status only. No enrollment, TOTP or permission
 * fact is derived here; credentials come from the server's ambient AWS chain. */
export function createCognitoSubjectStatus(options: CognitoSubjectStatusOptions) {
  try {
    const config = readClosedRecord(
      options,
      Object.hasOwn(options, "requestTimeoutMs")
        ? ["userPoolId", "clock", "requestTimeoutMs"]
        : ["userPoolId", "clock"],
    );
    const pool = config.userPoolId,
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
    const issuer = `https://cognito-idp.ca-central-1.amazonaws.com/${pool}`;
    const client = new CognitoIdentityProviderClient({
      region: "ca-central-1",
      endpoint: "https://cognito-idp.ca-central-1.amazonaws.com",
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: timeout, requestTimeout: timeout },
    });
    const observe = () => {
      if (
        options.userPoolId !== pool ||
        options.clock !== clock ||
        clock.now !== now ||
        (options.requestTimeoutMs ?? 4000) !== timeout
      )
        return denied();
      return parseCanonicalInstant(now.call(clock));
    };
    observe();
    return Object.freeze({
      async readCurrentProviderSubject(input: {
        readonly issuer: string;
        readonly subject: string;
        readonly observedAt: string;
      }): Promise<{
        readonly issuer: string;
        readonly subject: string;
        readonly status: "Enabled" | "Disabled";
        readonly observedAt: string;
        readonly validUntil: string;
      }> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = new AbortController();
        try {
          const value = readClosedRecord(input, ["issuer", "subject", "observedAt"]),
            subject = value.subject,
            observedAt = parseCanonicalInstant(value.observedAt);
          if (
            value.issuer !== issuer ||
            typeof subject !== "string" ||
            !/^[\x21-\x7e]{1,128}$/u.test(subject) ||
            subject.includes("@")
          )
            return denied();
          const original = Date.parse(observedAt),
            deadline = original + 5000;
          let latest = original;
          const check = () => {
            const at = Date.parse(observe());
            if (at < latest || at >= deadline) return denied();
            latest = at;
            return at;
          };
          const at = check();
          const result = await Promise.race([
            client.send(new AdminGetUserCommand({ UserPoolId: pool, Username: subject }), {
              abortSignal: abort.signal,
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => {
                  abort.abort();
                  reject(new BrowserSessionError("BROWSER_SESSION_DENIED"));
                },
                Math.min(timeout, deadline - at),
              );
            }),
          ]);
          check();
          if (
            result.UserStatus !== "CONFIRMED" ||
            typeof result.Enabled !== "boolean" ||
            !Array.isArray(result.UserAttributes) ||
            result.UserAttributes.length > 256
          )
            return denied();
          const subjects = result.UserAttributes.filter((attribute) => attribute.Name === "sub");
          if (
            subjects.length !== 1 ||
            subjects[0]?.Value !== subject ||
            result.UserAttributes.some((attribute) => attribute.Name === "identities")
          )
            return denied();
          return Object.freeze({
            issuer,
            subject,
            status: result.Enabled ? "Enabled" : "Disabled",
            observedAt,
            validUntil: parseCanonicalInstant(new Date(deadline).toISOString()),
          });
        } catch {
          return denied();
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          abort.abort();
        }
      },
    });
  } catch {
    return denied();
  }
}
