// WP-2423 (DEC-PILOT-SECRETS, DEC-PILOT-MAINTENANCE-PAGE): what the hosting provides to one pilot
// installation, `<runtime>/hosting.json` (0600, pilot operator). Absent file → the local internal
// test entry (https://127.0.0.1:4443, the runtime's self-signed certificate, generated test keys),
// exactly as before. The file never holds secret values: only where the hosting mounts them.
//
//   {
//     "schemaVersion": 1,
//     "environment": "Pilot",                       // must match this process (InternalTest|Pilot)
//     "customerOrigin": "https://order.example.ca", // printed on table QR codes; reprint on change
//     "secretsDirectory": "/run/secrets/bop-rms",   // Pilot only: one value per file (0400)
//     "tls": { "mode": "front", "certificateFile": "/run/tls/fullchain.pem",
//              "keyFile": "/run/tls/privkey.pem" }  // or { "mode": "proxy" }
//   }
import { X509Certificate, createPrivateKey } from "node:crypto";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import tls from "node:tls";
import { URL } from "node:url";
import { matchesPilotEnvironment } from "./pilot-environment.mjs";
import { readPrivateJson } from "./pilot-ops-files.mjs";

export const HOSTING_FILE = "hosting.json";
/** The local internal test entry every existing installation uses. */
export const INTERNAL_CUSTOMER_ORIGIN = "https://127.0.0.1:4443";

const fail = (reason) => {
  throw Object.assign(Error("PILOT_HOSTING_CONFIG_INVALID"), { reason });
};
const absolute = (value, reason) =>
  typeof value === "string" &&
  value.length <= 255 &&
  path.isAbsolute(value) &&
  path.normalize(value) === value &&
  !/[\0\r\n]/u.test(value)
    ? value
    : fail(reason);

/** `{ origin, host }` of an https origin without path, query, fragment or user information. */
export function parsePublicOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail("customerOrigin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin
  )
    return fail("customerOrigin");
  return Object.freeze({ origin: url.origin, host: url.host, hostname: url.hostname });
}

const RESERVED_SUFFIXES = [".local", ".localhost", ".test", ".example", ".invalid", ".internal"];
/** A name the public can reach: a DNS name with a dot, not an address or a reserved name. */
export function isPublicHostname(hostname) {
  const name = hostname.toLowerCase();
  return (
    isIP(name) === 0 &&
    name.includes(".") &&
    /^[a-z0-9.-]{1,253}$/u.test(name) &&
    !RESERVED_SUFFIXES.some((suffix) => name.endsWith(suffix)) &&
    !["example.com", "example.net", "example.org"].some(
      (base) => name === base || name.endsWith("." + base),
    )
  );
}

export function parsePilotHosting(value, options) {
  if (value === null)
    return Object.freeze({
      configured: false,
      ...parsePublicOrigin(INTERNAL_CUSTOMER_ORIGIN),
      secretsDirectory: null,
      tls: Object.freeze({ mode: "internal" }),
    });
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("keys");
  const allowed = ["schemaVersion", "environment", "customerOrigin", "secretsDirectory", "tls"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return fail("keys");
  if (value.schemaVersion !== 1) return fail("schemaVersion");
  if (!matchesPilotEnvironment(value.environment, options)) return fail("environment");
  const origin = parsePublicOrigin(value.customerOrigin);
  let secretsDirectory = null;
  if (value.environment === "Pilot")
    secretsDirectory = absolute(value.secretsDirectory, "secretsDirectory");
  // InternalTest keeps its generated local key files; a managed source is never mixed in. Its
  // DEMO staff login and simulated payments are never served on a public name either.
  else if (value.secretsDirectory !== undefined) return fail("secretsDirectory");
  else if (origin.origin !== INTERNAL_CUSTOMER_ORIGIN) return fail("customerOrigin.internal-test");
  let mode = Object.freeze({ mode: "internal" });
  if (value.tls !== undefined) {
    const t = value.tls;
    if (!t || typeof t !== "object" || Array.isArray(t)) return fail("tls");
    if (t.mode === "front") {
      if (Object.keys(t).sort().join(",") !== "certificateFile,keyFile,mode") return fail("tls");
      mode = Object.freeze({
        mode: "front",
        certificateFile: absolute(t.certificateFile, "tls.certificateFile"),
        keyFile: absolute(t.keyFile, "tls.keyFile"),
      });
    } else if (t.mode === "proxy") {
      if (Object.keys(t).join(",") !== "mode") return fail("tls");
      mode = Object.freeze({ mode: "proxy" });
    } else return fail("tls.mode");
  }
  return Object.freeze({ configured: true, ...origin, secretsDirectory, tls: mode });
}

export async function loadPilotHosting(runtimeDirectory, options) {
  return parsePilotHosting(
    await readPrivateJson(path.join(runtimeDirectory, HOSTING_FILE)),
    options,
  );
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
/**
 * Whether the certificate files the hosting mounted can serve the customer origin to phones:
 * a chain to a publicly trusted root (the Node root store), for this host name, currently valid,
 * matching the private key. Returns a fixed reason (never a path, name or key material).
 */
export async function checkCertificateFiles(
  { certificateFile, keyFile, hostname },
  { now = Date.now(), roots = tls.rootCertificates, read = fs.readFile } = {},
) {
  let chain, key;
  try {
    chain = ((await read(certificateFile, "utf8")).match(PEM_CERTIFICATE) ?? []).map(
      (pem) => new X509Certificate(pem),
    );
    key = createPrivateKey(await read(keyFile, "utf8"));
  } catch {
    return "certificate-unreadable";
  }
  if (chain.length === 0) return "certificate-unreadable";
  const [leaf] = chain;
  if (!leaf.checkPrivateKey(key)) return "certificate-key-mismatch";
  if (leaf.checkHost(hostname) === undefined) return "certificate-wrong-host";
  if (chain.some((c) => now < Date.parse(c.validFrom) || now >= Date.parse(c.validTo)))
    return "certificate-expired";
  for (let index = 0; index + 1 < chain.length; index += 1)
    if (
      !chain[index].checkIssued(chain[index + 1]) ||
      !chain[index].verify(chain[index + 1].publicKey)
    )
      return "certificate-not-trusted";
  const top = chain.at(-1);
  const trusted = roots.some((pem) => {
    try {
      const root = new X509Certificate(pem);
      return (
        root.fingerprint256 === top.fingerprint256 ||
        (top.checkIssued(root) && top.verify(root.publicKey))
      );
    } catch {
      return false;
    }
  });
  return trusted ? null : "certificate-not-trusted";
}

/** A TLS handshake to the public origin with the public trust store (TLS-terminating proxy). */
export function publicHandshake({ hostname, port }, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, servername: hostname, port, timeout: timeoutMs });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => done(socket.authorized ? null : "proxy-not-trusted"));
    socket.once("timeout", () => done("proxy-unreachable"));
    socket.once("error", () => done("proxy-unreachable"));
  });
}

/**
 * The "Tls" capability: met only with a public customer origin and a certificate phones trust,
 * either mounted here for the front (`front`) or presented by the hosting's TLS proxy (`proxy`).
 */
export async function checkPilotTls(
  hosting,
  { checkFiles = checkCertificateFiles, handshake = publicHandshake } = {},
) {
  if (!hosting.configured || hosting.origin === INTERNAL_CUSTOMER_ORIGIN)
    return "customer-origin-not-configured";
  if (!isPublicHostname(hosting.hostname)) return "customer-origin-not-public";
  if (hosting.tls.mode === "front")
    return checkFiles({
      certificateFile: hosting.tls.certificateFile,
      keyFile: hosting.tls.keyFile,
      hostname: hosting.hostname,
    });
  if (hosting.tls.mode === "proxy") {
    const port = Number(new URL(hosting.origin).port || 443);
    return handshake({ hostname: hosting.hostname, port });
  }
  return "certificate-not-configured";
}
