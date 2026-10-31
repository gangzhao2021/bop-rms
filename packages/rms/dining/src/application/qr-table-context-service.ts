import { parseDiningReference, parseDiningInstant } from "../domain/dining-session.js";
import {
  parseQrCompact,
  QrContractError,
  parseQrSignedPayload,
  parseQrTableContextEvidence,
  parseQrVerificationKeySetEvidence,
  parseResolveQrTableContextRequest,
  type QrTableContext,
  type ResolveQrTableContextResult,
} from "../contracts/qr-table-context.js";
import { resolveQrTableContextDecision } from "../domain/resolve-qr-table-context.js";
import type { QrTableContextPorts, QrTelemetryReason } from "./ports/qr-table-context-ports.js";

const invalid = Object.freeze({ status: "InvalidRequest" } as const);
const unavailable = Object.freeze({ status: "QrUnavailable" } as const);
const maximumLifetimeMilliseconds = 180 * 24 * 60 * 60 * 1000;
const compactSegmentPattern = /^[A-Za-z0-9_-]+$/u;

function hasValidCompactFraming(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !compactSegmentPattern.test(part))) return false;
  const signature = parts[2];
  if (signature === undefined) return false;
  const bytes = Buffer.from(signature, "base64url");
  return bytes.length === 64 && bytes.toString("base64url") === signature;
}

function record(
  ports: QrTableContextPorts,
  outcome: "VERIFIED" | "INVALID_REQUEST" | "QR_UNAVAILABLE",
  reason: QrTelemetryReason,
): void {
  try {
    ports.telemetry.record({ operation: "ResolveQrTableContext", outcome, reason });
  } catch {
    // Telemetry is non-authoritative.
  }
}

export function createQrTableContextService(ports: QrTableContextPorts) {
  return Object.freeze({
    async resolveQrTableContext(request: unknown): Promise<ResolveQrTableContextResult> {
      let parsedRequest;
      try {
        parsedRequest = parseResolveQrTableContextRequest(request);
      } catch {
        record(ports, "INVALID_REQUEST", "REQUEST_INVALID");
        return invalid;
      }
      if (!hasValidCompactFraming(parsedRequest.qrToken)) {
        record(ports, "INVALID_REQUEST", "REQUEST_INVALID");
        return invalid;
      }
      let compact;
      try {
        compact = parseQrCompact(parsedRequest.qrToken);
      } catch {
        record(ports, "QR_UNAVAILABLE", "QR_UNAVAILABLE");
        return unavailable;
      }
      try {
        const keySet = parseQrVerificationKeySetEvidence(await ports.keys.load());
        const matches = keySet.keys.filter((key) => key.kid === compact.header.kid);
        if (matches.length !== 1 || matches[0] === undefined) {
          record(ports, "QR_UNAVAILABLE", "QR_UNAVAILABLE");
          return unavailable;
        }
        const key = matches[0];
        const verification = await ports.verifier.verify({
          algorithm: "ES256",
          publicKeyReference: key.publicKeyReference,
          signingInput: compact.signingInput,
          signature: compact.signature,
        });
        if (verification !== "Verified") {
          record(ports, "QR_UNAVAILABLE", "QR_UNAVAILABLE");
          return unavailable;
        }
        const payload = parseQrSignedPayload(compact.encodedPayload);
        const rawContext = await ports.contexts.resolve(payload);
        if (rawContext === null) {
          record(ports, "QR_UNAVAILABLE", "QR_UNAVAILABLE");
          return unavailable;
        }
        const context = parseQrTableContextEvidence(rawContext);
        const contextMatches =
          context.publicStoreReference === payload.publicStoreReference &&
          context.publicTableReference === payload.publicTableReference &&
          context.channel === payload.channel;
        const activeContext =
          context.brandLifecycle === "Active" &&
          context.storeLifecycle === "Active" &&
          context.qrState === "Enabled" &&
          (payload.channel === "Pickup" ||
            (context.tableLifecycle === "Active" && context.assignmentState === "Active"));
        if (
          !resolveQrTableContextDecision({
            evaluatedAt: parsedRequest.evaluatedAt,
            issuedAt: payload.issuedAt,
            expiresAt: payload.expiresAt,
            maximumLifetimeMilliseconds,
            keyValidFrom: key.validFrom,
            keyValidUntil: key.validUntil,
            compromisedAt: key.compromisedAt,
            registryValidUntil: keySet.validUntil,
            contextValidUntil: context.validUntil,
            contextMatches,
            activeContext,
            revocationMatches: context.revocationVersion === payload.revocationVersion,
          })
        ) {
          record(ports, "QR_UNAVAILABLE", "QR_UNAVAILABLE");
          return unavailable;
        }
        const output: QrTableContext = Object.freeze({
          qrReference: payload.qrReference,
          publicStoreReference: payload.publicStoreReference,
          publicTableReference: payload.publicTableReference,
          channel: payload.channel,
          locale: payload.locale,
          issuedAt: payload.issuedAt,
          expiresAt: payload.expiresAt,
          revocationVersion: payload.revocationVersion,
        });
        record(ports, "VERIFIED", "CONTEXT_VERIFIED");
        return Object.freeze({ status: "Verified", context: output });
      } catch {
        record(ports, "QR_UNAVAILABLE", "DEPENDENCY_UNAVAILABLE");
        return unavailable;
      }
    },
  });
}

/** Current context for an already authenticated Guest; never verifies or reconstructs a signed QR. */
export function assertCurrentDiningGuestTableContext(input: unknown, value: unknown) {
  try {
    const fields = [
      "brandReference",
      "storeReference",
      "publicStoreReference",
      "publicTableReference",
      "channel",
      "qrRevocationVersion",
      "observedAt",
    ];
    if (
      input === null ||
      typeof input !== "object" ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).length !== fields.length
    )
      throw new QrContractError();
    const entries = fields.map((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new QrContractError();
      return [field, descriptor.value] as const;
    });
    const raw = Object.fromEntries(entries);
    const brand = String(parseDiningReference(raw.brandReference));
    const store = String(parseDiningReference(raw.storeReference));
    const publicStore = String(parseDiningReference(raw.publicStoreReference));
    const publicTable = String(parseDiningReference(raw.publicTableReference));
    const at = parseDiningInstant(raw.observedAt);
    const context = parseQrTableContextEvidence(value);
    if (
      raw.channel !== "DineIn" ||
      !Number.isSafeInteger(raw.qrRevocationVersion) ||
      raw.qrRevocationVersion < 1 ||
      context.brandReference !== brand ||
      context.storeReference !== store ||
      context.publicStoreReference !== publicStore ||
      context.publicTableReference !== publicTable ||
      context.channel !== "DineIn" ||
      context.tableReference === null ||
      context.revocationVersion !== raw.qrRevocationVersion ||
      context.brandLifecycle !== "Active" ||
      context.storeLifecycle !== "Active" ||
      context.tableLifecycle !== "Active" ||
      context.assignmentState !== "Active" ||
      context.qrState !== "Enabled" ||
      String(context.validUntil) <= String(at)
    )
      throw new QrContractError();
    return context;
  } catch {
    throw new QrContractError();
  }
}
