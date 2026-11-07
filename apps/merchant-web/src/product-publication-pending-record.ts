import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
} from "./catalog-product-command-values.js";
import { parseProductPublicationUserCommand } from "./product-publication-command-client.js";
export interface PublicationPendingScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly productReference: string;
}
export class PublicationPendingRecordError extends Error {
  constructor() {
    super("Original publication request record is unavailable");
    this.name = "PublicationPendingRecordError";
  }
}
const fail = (): never => {
  throw new PublicationPendingRecordError();
};
function scope(value: unknown): PublicationPendingScope {
  const r = record(copyProductCommandValue(value), [
    "tenantReference",
    "brandReference",
    "storeReference",
    "productReference",
  ]);
  return Object.freeze({
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    storeReference: ref(r.storeReference),
    productReference: ref(r.productReference),
  });
}
async function digest(value: unknown) {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return (
    "sha256:" + Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}
function normalized(command: unknown, selected: PublicationPendingScope) {
  const parsed = parseProductPublicationUserCommand(command);
  if (parsed.productReference !== selected.productReference || parsed.reasonCode !== "USER_REQUEST")
    return fail();
  const body = JSON.stringify(parsed);
  if (new TextEncoder().encode(body).byteLength > 8192) return fail();
  return { command: parsed, body };
}
/** Nonsecret original intent only. This digest is integrity, never authentication. */
export async function buildPublicationPendingRecord(
  command: unknown,
  selected: PublicationPendingScope,
) {
  try {
    const s = scope(selected),
      v = normalized(command, s);
    const body = Object.freeze({
      profile: "CatalogProductPublicationPendingV1" as const,
      ...s,
      operationReference: v.command.operationReference,
      body: v.body,
    });
    const result = Object.freeze({ ...body, digest: await digest(body) });
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384) return fail();
    return result;
  } catch {
    return fail();
  }
}
export type PublicationPendingRecord = Awaited<ReturnType<typeof buildPublicationPendingRecord>>;
export async function parsePublicationPendingRecord(
  value: unknown,
  expected: PublicationPendingScope,
) {
  try {
    const s = scope(expected),
      raw = record(copyProductCommandValue(value), [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "productReference",
        "operationReference",
        "body",
        "digest",
      ]);
    if (
      raw.profile !== "CatalogProductPublicationPendingV1" ||
      typeof raw.body !== "string" ||
      new TextEncoder().encode(raw.body).byteLength > 8192 ||
      typeof raw.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(raw.digest)
    )
      return fail();
    for (const key of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
    ] as const)
      if (raw[key] !== s[key]) return fail();
    const v = normalized(JSON.parse(raw.body), s);
    if (v.body !== raw.body || v.command.operationReference !== raw.operationReference)
      return fail();
    const rebuilt = await buildPublicationPendingRecord(v.command, s);
    if (
      rebuilt.digest !== raw.digest ||
      new TextEncoder().encode(JSON.stringify(raw)).byteLength > 16384
    )
      return fail();
    return Object.freeze({ record: rebuilt, command: v.command, scope: s });
  } catch {
    return fail();
  }
}
