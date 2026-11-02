import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import express, { type Request, type RequestHandler, type Response } from "express";
import { trustedClientAddress } from "./client-address.js";
import { CustomerMemberError, type CustomerMemberPort } from "./customer-member.js";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: `POST /bff/customer/member`, one closed action per request. The
 * phone and code are only ever in the body, never in a URL, a log or an error.
 */
export const customerMemberRoute = "/bff/customer/member";
export const memberSessionCookieName = "__Host-bop-member";
const credential = /^[A-Za-z0-9_-]{43}$/u;
const operation = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const statusOf: Record<CustomerMemberError["code"], [number, string]> = {
  MEMBER_NOT_OFFERED: [404, "member_not_offered"],
  MEMBER_PHONE_INVALID: [422, "member_phone_invalid"],
  MEMBER_CODE_UNAVAILABLE: [503, "member_code_unavailable"],
  MEMBER_RATE_LIMITED: [429, "member_rate_limited"],
  MEMBER_CODE_WRONG: [422, "member_code_wrong"],
  MEMBER_CODE_ENDED: [422, "member_code_ended"],
  MEMBER_SIGN_IN_REQUIRED: [401, "member_sign_in_required"],
  MEMBER_NOT_FOUND: [404, "member_not_found"],
  MEMBER_NOTHING_TO_CLAIM: [409, "member_nothing_to_claim"],
  MEMBER_ALREADY_EARNED: [409, "member_already_earned"],
  MEMBER_NOT_ENOUGH_POINTS: [409, "member_not_enough_points"],
  MEMBER_REDEEM_INVALID: [422, "member_redeem_invalid"],
  MEMBER_REDEEM_NOT_THIS_TABLE: [409, "member_redeem_not_this_table"],
  MEMBER_REDEEM_SPLIT: [409, "member_redeem_split"],
  MEMBER_REDEEM_PAID: [409, "member_redeem_paid"],
  MEMBER_REDEEM_GUEST_PAYING: [409, "member_redeem_guest_paying"],
  MEMBER_UNAVAILABLE: [503, "member_unavailable"],
};
const protect = (response: Response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
};
const cookieOf = (request: Request, name: string) => {
  const found = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .filter(([key]) => key === name);
  return found.length === 1 && found[0]?.length === 2 ? (found[0][1] ?? null) : null;
};
const orderOf = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && operation.test(value)) return value;
  throw new Error("MEMBER_INPUT");
};
const part = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 20)
    return value as number;
  throw new Error("MEMBER_INPUT");
};

export class CustomerMemberHandler {
  readonly #origin: string;
  readonly #load: () => Promise<CustomerMemberPort>;
  constructor(options: {
    readonly allowedOrigin: string;
    /** Composed on first use: without its key, points are unavailable, never the Store. */
    readonly port: () => Promise<CustomerMemberPort>;
  }) {
    this.#origin = options.allowedOrigin;
    this.#load = options.port;
  }
  #credentials(request: Request) {
    if (
      (request.get("origin") !== undefined && request.get("origin") !== this.#origin) ||
      request.get("sec-fetch-site") !== "same-origin" ||
      Object.keys(request.query).length !== 0
    )
      return null;
    const session = cookieOf(request, "__Host-bop-guest");
    const csrf = request.headers["x-csrf-token"];
    if (
      session === null ||
      !credential.test(session) ||
      typeof csrf !== "string" ||
      !credential.test(csrf)
    )
      return null;
    const member = cookieOf(request, memberSessionCookieName);
    return Object.freeze({
      sessionCredential: String(parseGuestRawCredential(session)),
      csrfCredential: String(parseGuestRawCredential(csrf)),
      memberToken: member !== null && credential.test(member) ? member : null,
    });
  }
  handler(): RequestHandler[] {
    return [
      express.json({ limit: "2kb", strict: true }),
      async (request, response) => {
        protect(response);
        const credentials = this.#credentials(request);
        if (credentials === null) {
          response
            .status(400)
            .json({ schemaVersion: 1, error: { code: "member_request_invalid" } });
          return;
        }
        const address = trustedClientAddress(request);
        let port: CustomerMemberPort;
        try {
          port = await this.#load();
        } catch {
          response.setHeader("Retry-After", "30");
          response.status(503).json({ schemaVersion: 1, error: { code: "member_unavailable" } });
          return;
        }
        try {
          const body = (request.body ?? {}) as Record<string, unknown>;
          let answer: unknown;
          switch (body.action) {
            case "State": {
              const raw = readClosedRecord(body, [
                "action",
                ...(Object.hasOwn(body, "orderReference") ? ["orderReference"] : []),
              ]);
              answer = await port.state(credentials, orderOf(raw.orderReference));
              break;
            }
            case "SendCode": {
              const raw = readClosedRecord(body, ["action", "phone"]);
              answer = await port.sendCode(credentials, raw.phone, address);
              break;
            }
            case "Verify": {
              const raw = readClosedRecord(body, [
                "action",
                "phone",
                "code",
                "marketingConsent",
                "claim",
                ...(Object.hasOwn(body, "partNumber") ? ["partNumber"] : []),
                ...(Object.hasOwn(body, "orderReference") ? ["orderReference"] : []),
              ]);
              if (typeof raw.marketingConsent !== "boolean" || typeof raw.claim !== "boolean")
                throw new Error("MEMBER_INPUT");
              const result = await port.verify(
                credentials,
                {
                  phone: raw.phone,
                  code: raw.code,
                  marketingConsent: raw.marketingConsent,
                  claim: raw.claim,
                  partNumber: part(raw.partNumber),
                  orderReference: orderOf(raw.orderReference),
                },
                address,
              );
              response.setHeader(
                "Set-Cookie",
                `${memberSessionCookieName}=${result.token}; Path=/; Max-Age=${String(
                  Math.max(0, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000)),
                )}; Secure; HttpOnly; SameSite=Lax`,
              );
              answer = { joined: result.joined, earnedPoints: result.earnedPoints };
              break;
            }
            case "Claim": {
              const raw = readClosedRecord(body, [
                "action",
                ...(Object.hasOwn(body, "partNumber") ? ["partNumber"] : []),
                ...(Object.hasOwn(body, "orderReference") ? ["orderReference"] : []),
              ]);
              answer = await port.claim(
                credentials,
                part(raw.partNumber),
                orderOf(raw.orderReference),
              );
              break;
            }
            case "Home":
              readClosedRecord(body, ["action"]);
              answer = await port.home(credentials);
              break;
            case "RedemptionOptions":
              readClosedRecord(body, ["action"]);
              answer = await port.redemptionOptions(credentials);
              break;
            case "Redeem": {
              const raw = readClosedRecord(body, [
                "action",
                "operationReference",
                ...(Object.hasOwn(body, "points") ? ["points"] : []),
                ...(Object.hasOwn(body, "rewardProductReference")
                  ? ["rewardProductReference"]
                  : []),
              ]);
              const reward = raw.rewardProductReference ?? null;
              const points = raw.points ?? null;
              if (
                typeof raw.operationReference !== "string" ||
                !operation.test(raw.operationReference) ||
                (reward === null) === (points === null) ||
                (reward !== null &&
                  (typeof reward !== "string" || !/^[0-9a-f-]{36}$/u.test(reward))) ||
                (points !== null && !Number.isSafeInteger(points))
              )
                throw new Error("MEMBER_INPUT");
              answer = await port.redeem(credentials, {
                operationReference: raw.operationReference,
                points: points as number | null,
                rewardProductReference: reward as string | null,
              });
              break;
            }
            case "SetMarketingConsent": {
              const raw = readClosedRecord(body, ["action", "given"]);
              if (typeof raw.given !== "boolean") throw new Error("MEMBER_INPUT");
              answer = await port.setMarketingConsent(credentials, raw.given);
              break;
            }
            case "SignOut":
            case "Leave":
              readClosedRecord(body, ["action"]);
              answer =
                body.action === "SignOut"
                  ? await port.signOut(credentials)
                  : await port.leave(credentials);
              response.setHeader(
                "Set-Cookie",
                `${memberSessionCookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
              );
              break;
            default:
              throw new Error("MEMBER_INPUT");
          }
          response.status(200).json({ schemaVersion: 1, ...(answer as object) });
        } catch (error) {
          if (error instanceof CustomerMemberError) {
            const [status, code] = statusOf[error.code];
            if (error.retryAfterSeconds !== null)
              response.setHeader("Retry-After", String(error.retryAfterSeconds));
            else if (status === 503) response.setHeader("Retry-After", "30");
            response.status(status).json({
              schemaVersion: 1,
              error: {
                code,
                ...(error.retryAfterSeconds === null
                  ? {}
                  : { retryAfterSeconds: error.retryAfterSeconds }),
              },
            });
            return;
          }
          response
            .status(400)
            .json({ schemaVersion: 1, error: { code: "member_request_invalid" } });
        }
      },
    ];
  }
}
