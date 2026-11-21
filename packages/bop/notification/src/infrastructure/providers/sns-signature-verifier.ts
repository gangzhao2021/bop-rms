import { X509Certificate, createVerify } from "node:crypto";
import { request } from "node:https";

/** Fetches one signing certificate; tests inject a local fake. */
export type SnsCertificateFetch = (url: URL) => Promise<string>;

const certificateUrl =
  /^https:\/\/sns\.ca-central-1\.amazonaws\.com\/SimpleNotificationService-[A-Za-z0-9_-]{32,128}\.pem$/u;
const maximumBytes = 16_384;

/**
 * The only outbound security-metadata fetch allowed by IDR-0032: the SNS signing certificate from
 * the exact AWS SNS HTTPS host and path (validated before calling), TLS-verified against the system
 * trust store, no redirect, bounded size and time, no inbound credentials forwarded.
 */
export function createHttpsSnsCertificateFetch(timeoutMs = 5_000): SnsCertificateFetch {
  return (url) =>
    new Promise((resolve, reject) => {
      if (!certificateUrl.test(url.href)) {
        reject(new Error("SNS_CERTIFICATE_URL_DENIED"));
        return;
      }
      const call = request(
        url,
        { method: "GET", timeout: timeoutMs, headers: { accept: "application/x-pem-file" } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error("SNS_CERTIFICATE_UNAVAILABLE"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximumBytes) {
              call.destroy(new Error("SNS_CERTIFICATE_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          response.on("error", reject);
        },
      );
      call.on("timeout", () => call.destroy(new Error("SNS_CERTIFICATE_TIMEOUT")));
      call.on("error", reject);
      call.end();
    });
}

/**
 * SNS Signature Version 2 (RSA SHA-256) verifier. The certificate must be the SNS signing
 * certificate (subject `sns.amazonaws.com` or the regional name), currently valid, and is cached per URL for at most one
 * hour. Any doubt is a verification failure (the event is refused before any write).
 */
export function createSnsSignatureVerifier(options: {
  readonly fetchCertificate: SnsCertificateFetch;
  readonly clock: { now(): string };
  /** Test seam: parse the PEM (defaults to node:crypto X509Certificate). */
  readonly parseCertificate?: (
    pem: string,
  ) => Pick<X509Certificate, "subject" | "validFrom" | "validTo" | "publicKey">;
}) {
  const parse = options.parseCertificate ?? ((pem: string) => new X509Certificate(pem));
  const cache = new Map<string, { readonly pem: string; readonly fetchedAt: number }>();
  async function certificate(url: string) {
    const now = Date.parse(options.clock.now());
    const cached = cache.get(url);
    let pem: string;
    if (cached && now - cached.fetchedAt < 3_600_000) pem = cached.pem;
    else {
      pem = await options.fetchCertificate(new URL(url));
      if (cache.size >= 8) cache.clear();
      cache.set(url, { pem, fetchedAt: now });
    }
    const parsed = parse(pem);
    if (
      !/(^|\n)CN=sns(\.ca-central-1)?\.amazonaws\.com(\n|$)/u.test(parsed.subject) ||
      Date.parse(parsed.validFrom) > now ||
      Date.parse(parsed.validTo) <= now
    )
      throw new Error("SNS_CERTIFICATE_INVALID");
    return parsed;
  }
  return Object.freeze({
    async verifyVersion2(input: {
      readonly signingCertificateUrl: string;
      readonly canonicalMessage: string;
      readonly signature: string;
    }): Promise<boolean> {
      if (!certificateUrl.test(input.signingCertificateUrl)) return false;
      const parsed = await certificate(input.signingCertificateUrl);
      const verifier = createVerify("RSA-SHA256");
      verifier.update(input.canonicalMessage, "utf8");
      verifier.end();
      return verifier.verify(parsed.publicKey, input.signature, "base64");
    },
  });
}
