import {
  parseQrCompact,
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
