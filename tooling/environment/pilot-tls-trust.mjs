import { Buffer } from "node:buffer";
import { X509Certificate, createHash } from "node:crypto";

/**
 * WP-2423: how a browser trusts the local InternalTest HTTPS entry.
 *
 * The entry's certificate is self-signed. A browser that only clicks through the warning (or a
 * Playwright context with `ignoreHTTPSErrors`) still fails the TLS handshake of every new
 * connection and restarts each request after allowing the error. With HTTP/1.1 a page opens up to
 * six connections at once; Chromium hands each failed connection to the highest-priority waiting
 * request (the main stylesheet), whose restart budget runs out: `net::ERR_TOO_MANY_RETRIES` and an
 * unstyled page on 3 of 5 fresh loads (WP-2423, 2026-10-15). Staff devices must trust this exact
 * certificate instead; automated browsers pin its public key, which makes the handshake succeed.
 */
export function pilotCertificatePublicKeyPin(certificatePem) {
  if (typeof certificatePem !== "string" && !Buffer.isBuffer(certificatePem))
    throw new Error("PILOT_TLS_CERTIFICATE_INVALID");
  let certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new Error("PILOT_TLS_CERTIFICATE_INVALID");
  }
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64");
}

/** Chromium launch arguments that trust only this certificate's key (no global bypass). */
export function pilotChromiumTrustArguments(certificatePem) {
  return ["--ignore-certificate-errors-spki-list=" + pilotCertificatePublicKeyPin(certificatePem)];
}
