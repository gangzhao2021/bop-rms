import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { URL } from "node:url";

const policyUrl = new URL("../../docs/security/upload-egress-policy.json", import.meta.url);

export async function loadUploadEgressPolicy() {
  return JSON.parse(await readFile(policyUrl, "utf8"));
}

const signatures = {
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  "image/webp": (bytes) =>
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP",
  "application/pdf": (bytes) => bytes.subarray(0, 5).toString("ascii") === "%PDF-",
};

export function inspectUpload({ declaredType, bytes, byteSize, pixels = null, malwareClean }) {
  const errors = [];
  const allTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  if (!allTypes.has(declaredType)) errors.push("TYPE_NOT_ALLOWED");
  if (!Buffer.isBuffer(bytes) || signatures[declaredType]?.(bytes) !== true)
    errors.push("CONTENT_SIGNATURE");
  const prefix = Buffer.isBuffer(bytes) ? bytes.subarray(0, 4096).toString("latin1") : "";
  if (
    /<(?:script|svg|html)[\s>]|javascript:/iu.test(prefix) ||
    (Buffer.isBuffer(bytes) && bytes.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
  )
    errors.push("ACTIVE_OR_POLYGLOT_CONTENT");
  const maximum = declaredType === "application/pdf" ? 26_214_400 : 10_485_760;
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > maximum)
    errors.push("SIZE_LIMIT");
  if (
    declaredType.startsWith("image/") &&
    (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > 25_000_000)
  )
    errors.push("PIXEL_LIMIT");
  if (malwareClean !== true) errors.push("MALWARE_QUARANTINE");
  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}

function blockedIp(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const value = address.toLowerCase();
  return (
    isIP(address) === 6 &&
    (value === "::1" ||
      value === "::" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("ff"))
  );
}

export function validateOutboundHop({ url, approvedHost, resolvedAddresses, inboundHeaders = {} }) {
  const errors = [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    errors.push("URL_INVALID");
  }
  if (parsed) {
    if (parsed.protocol !== "https:") errors.push("SCHEME");
    if (parsed.hostname !== approvedHost) errors.push("HOST");
    if (parsed.username || parsed.password) errors.push("USERINFO");
  }
  if (
    !Array.isArray(resolvedAddresses) ||
    resolvedAddresses.length === 0 ||
    resolvedAddresses.some(blockedIp)
  )
    errors.push("DNS_ADDRESS");
  if (
    Object.keys(inboundHeaders).some((name) => /^(?:authorization|cookie|x-bop-csrf)$/iu.test(name))
  )
    errors.push("CREDENTIAL_FORWARDING");
  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}

export function validateSignedDownload(evidence) {
  const errors = [];
  if (evidence.freshAuthorization !== true) errors.push("AUTHORIZATION");
  if (
    !Number.isInteger(evidence.ttlSeconds) ||
    evidence.ttlSeconds < 1 ||
    evidence.ttlSeconds > 300
  )
    errors.push("TTL");
  if (evidence.filename !== "download") errors.push("FILENAME");
  if (evidence.disposition !== "attachment") errors.push("DISPOSITION");
  if (evidence.privateObject !== true || evidence.cloudFrontCacheable !== false)
    errors.push("PRIVATE_STORAGE");
  if (evidence.telemetryCaptured !== false || evidence.referrerExposed !== false)
    errors.push("URL_LEAK");
  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}
