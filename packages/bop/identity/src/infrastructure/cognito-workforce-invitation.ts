import { createHash } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  BrowserSessionError,
  parseRawBrowserCredential,
  parseSelectorHash,
} from "../contracts/browser-session.js";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
} from "../contracts/identity-actor.js";
import {
  parseWorkforceAccountBindingConfiguration,
  parseWorkforceAccountBindingSubject,
} from "../contracts/workforce-account-binding.js";
import type { BrowserCredentialHasherPort } from "../application/ports/session-credential-ports.js";

export interface CognitoWorkforceInvitationOptions {
  readonly configuration: {
    readonly environment: string;
    readonly issuer: string;
    readonly clientId: string;
  };
  readonly clock: { now(): string };
  readonly hasher: BrowserCredentialHasherPort;
  readonly requestTimeoutMs?: number;
}
export interface CognitoWorkforceInvitationProviderAccount {
  readonly username: string;
  readonly subject: string;
  readonly status: "FORCE_CHANGE_PASSWORD" | "CONFIRMED";
  readonly enabled: boolean;
  readonly createdAt: string;
}
export interface CognitoWorkforceInvitationObservation {
  readonly profile: "CognitoWorkforceInvitationObservationV1";
  readonly actorReference: string;
  readonly creationIntentDigest: string;
  readonly emailDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly status: "Created" | "Found" | "NotFound" | "Mismatch" | "Unknown";
  readonly dispatchAccepted: true | null;
  readonly provider: CognitoWorkforceInvitationProviderAccount | null;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const digest = (value: unknown): string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : denied();
const email = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    value !== value.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return denied();
  return value.toLowerCase();
};
const field = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return denied();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : denied();
};

/** Provider account creation/observation only. Pool invitation/password/MFA and
 * immutable tag configuration are deployment prerequisites, not verified here.
 * No delivery confirmation, permission, invitation acceptance or MFA is inferred. */
export function createCognitoWorkforceInvitation(options: CognitoWorkforceInvitationOptions) {
  try {
    readClosedRecord(options, [
      "configuration",
      "clock",
      "hasher",
      ...(Object.hasOwn(options, "requestTimeoutMs") ? ["requestTimeoutMs"] : []),
    ]);
    const configurationPort = options.configuration,
      raw = readClosedRecord(configurationPort, ["environment", "issuer", "clientId"]),
      configuration = parseWorkforceAccountBindingConfiguration({
        environment: raw.environment,
        issuer: raw.issuer,
        clientIds: [raw.clientId],
      }),
      clientId = configuration.clientIds[0],
      clock = options.clock,
      now = readClosedRecord(clock, ["now"]).now,
      hasher = options.hasher,
      hash = readClosedRecord(hasher, ["hash", "equals"]).hash,
      equals = hasher.equals,
      timeout = options.requestTimeoutMs ?? 4000;
    if (
      !clientId ||
      typeof now !== "function" ||
      typeof hash !== "function" ||
      typeof equals !== "function" ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 5000
    )
      return denied();
    const pool = configuration.issuer.slice(configuration.issuer.lastIndexOf("/") + 1),
      client = new CognitoIdentityProviderClient({
        region: "ca-central-1",
        endpoint: "https://cognito-idp.ca-central-1.amazonaws.com",
        useFipsEndpoint: false,
        useDualstackEndpoint: false,
        maxAttempts: 1,
        requestHandler: { connectionTimeout: timeout, requestTimeout: timeout },
      }),
      send = client.send;
    let poisoned = false;
    const observe = (): string => {
      try {
        if (
          poisoned ||
          options.configuration !== configurationPort ||
          options.clock !== clock ||
          options.hasher !== hasher ||
          configurationPort.environment !== configuration.environment ||
          configurationPort.issuer !== configuration.issuer ||
          configurationPort.clientId !== clientId ||
          clock.now !== now ||
          hasher.hash !== hash ||
          hasher.equals !== equals ||
          (options.requestTimeoutMs ?? 4000) !== timeout ||
          client.send !== send
        )
          return denied();
        return parseCanonicalInstant(now.call(clock));
      } catch {
        poisoned = true;
        return denied();
      }
    };
    const emailHash = (value: unknown): string => {
      const normalized = email(value),
        preimage = JSON.stringify({
          domain: "COGNITO_WORKFORCE_INVITATION_EMAIL_V1",
          environment: configuration.environment,
          issuer: configuration.issuer,
          clientId,
          email: normalized,
        }),
        credential = parseRawBrowserCredential(
          createHash("sha256").update(preimage).digest("base64url"),
        ),
        result = parseSelectorHash(hash.call(hasher, credential));
      observe();
      return result;
    };
    observe();
    const run = async (
      input: unknown,
      mode: "create" | "inspect",
    ): Promise<CognitoWorkforceInvitationObservation> => {
      const r = readClosedRecord(
          input,
          mode === "create"
            ? ["actorReference", "creationIntentDigest", "corporateEmail"]
            : [
                "actorReference",
                "creationIntentDigest",
                "emailDigest",
                "creationStartedAt",
                "expectedSubject",
                "expectedCreatedAt",
              ],
        ),
        actorReference = String(parseOpaqueUuidV7(r.actorReference, "ACTOR_REFERENCE_INVALID")),
        creationIntentDigest = digest(r.creationIntentDigest),
        normalizedEmail = mode === "create" ? email(r.corporateEmail) : null,
        emailDigest =
          mode === "create" ? emailHash(normalizedEmail) : String(parseSelectorHash(r.emailDigest)),
        expectedSubject =
          mode === "inspect" && r.expectedSubject !== null
            ? parseWorkforceAccountBindingSubject(r.expectedSubject)
            : null,
        expectedCreatedAt =
          mode === "inspect" && r.expectedCreatedAt !== null
            ? parseCanonicalInstant(r.expectedCreatedAt)
            : null,
        observedAt = observe(),
        original = Date.parse(observedAt),
        deadline = original + 5000,
        creationStartedAt =
          mode === "inspect" ? parseCanonicalInstant(r.creationStartedAt) : observedAt,
        username = `bop_${actorReference}`;
      if (
        (expectedSubject === null) !== (expectedCreatedAt === null) ||
        creationStartedAt > observedAt ||
        (expectedCreatedAt !== null &&
          (expectedCreatedAt < creationStartedAt || expectedCreatedAt > observedAt))
      )
        return denied();
      let latest = original;
      const check = () => {
        const at = Date.parse(observe());
        if (at < latest) {
          poisoned = true;
          return denied();
        }
        latest = at;
        return at < deadline;
      };
      const packet = (
        status: CognitoWorkforceInvitationObservation["status"],
        provider: CognitoWorkforceInvitationProviderAccount | null = null,
      ): CognitoWorkforceInvitationObservation =>
        Object.freeze({
          profile: "CognitoWorkforceInvitationObservationV1",
          actorReference,
          creationIntentDigest,
          emailDigest,
          observedAt,
          validUntil: parseCanonicalInstant(new Date(deadline).toISOString()),
          status,
          dispatchAccepted: status === "Created" ? true : null,
          provider,
        });
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined, response: unknown;
      try {
        if (!check()) return packet("Unknown");
        try {
          const command =
            mode === "create"
              ? new AdminCreateUserCommand({
                  UserPoolId: pool,
                  Username: username,
                  DesiredDeliveryMediums: ["EMAIL"],
                  ForceAliasCreation: false,
                  UserAttributes: [
                    { Name: "email", Value: normalizedEmail ?? denied() },
                    { Name: "custom:bop_invitation_intent", Value: creationIntentDigest },
                  ],
                })
              : new AdminGetUserCommand({ UserPoolId: pool, Username: username });
          response = await Promise.race([
            command instanceof AdminCreateUserCommand
              ? client.send(command, { abortSignal: abort.signal })
              : client.send(command, { abortSignal: abort.signal }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => {
                  abort.abort();
                  reject(new Error("Provider observation unavailable"));
                },
                Math.min(timeout, deadline - latest),
              );
            }),
          ]);
        } catch (error) {
          if (!check()) return packet("Unknown");
          return packet(
            mode === "inspect" && error instanceof UserNotFoundException ? "NotFound" : "Unknown",
          );
        }
        if (!check()) return packet("Unknown");
        try {
          const user = mode === "create" ? field(response, "User") : response,
            actualUsername = field(user, "Username"),
            enabled = field(user, "Enabled"),
            status = field(user, "UserStatus"),
            createdDate = field(user, "UserCreateDate"),
            attributes = field(user, mode === "create" ? "Attributes" : "UserAttributes");
          if (
            typeof enabled !== "boolean" ||
            (status !== "FORCE_CHANGE_PASSWORD" && status !== "CONFIRMED") ||
            !(createdDate instanceof Date) ||
            !Array.isArray(attributes) ||
            attributes.length > 256
          )
            return packet("Unknown");
          const createdAt = parseCanonicalInstant(
              new Date(Date.prototype.getTime.call(createdDate)).toISOString(),
            ),
            values = new Map<string, string>();
          for (let index = 0; index < attributes.length; index++) {
            const item = field(attributes, String(index)),
              name = field(item, "Name");
            if (name === "identities") return packet("Mismatch");
            if (name !== "sub" && name !== "email" && name !== "custom:bop_invitation_intent")
              continue;
            const value = field(item, "Value");
            if (typeof value !== "string" || values.has(name)) return packet("Unknown");
            values.set(name, value);
          }
          const subject = parseWorkforceAccountBindingSubject(values.get("sub")),
            actualEmailHash = emailHash(values.get("email"));
          if (!check()) return packet("Unknown");
          const sameEmail = equals.call(
            hasher,
            parseSelectorHash(actualEmailHash),
            parseSelectorHash(emailDigest),
          );
          if (!check()) return packet("Unknown");
          if (typeof sameEmail !== "boolean") return packet("Unknown");
          if (
            actualUsername !== username ||
            values.get("custom:bop_invitation_intent") !== creationIntentDigest ||
            sameEmail !== true ||
            createdAt < creationStartedAt ||
            Date.parse(createdAt) > latest ||
            (expectedSubject !== null && subject !== expectedSubject) ||
            (expectedCreatedAt !== null && createdAt !== expectedCreatedAt)
          ) {
            observe();
            return packet("Mismatch");
          }
          if (!check()) return packet("Unknown");
          return packet(
            mode === "create" ? "Created" : "Found",
            Object.freeze({ username, subject, status, enabled, createdAt }),
          );
        } catch {
          observe();
          return packet("Unknown");
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        abort.abort();
      }
    };
    return Object.freeze({
      digestCorporateEmail(corporateEmail: unknown): string {
        try {
          observe();
          return emailHash(corporateEmail);
        } catch {
          return denied();
        }
      },
      create: (input: unknown) => run(input, "create").catch(() => denied()),
      inspect: (input: unknown) => run(input, "inspect").catch(() => denied()),
    });
  } catch {
    return denied();
  }
}
