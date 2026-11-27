import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
} from "./catalog-product-command-values.js";
import { parseProductPublicationUserCommandV2 } from "./product-publication-command-client-v2.js";
export interface PublicationPendingScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly productReference: string;
}
export class PublicationPendingRecordV2Error extends Error {
  constructor() {
    super("Original publication request record is unavailable");
    this.name = "PublicationPendingRecordV2Error";
  }
}
const fail = (): never => {
  throw new PublicationPendingRecordV2Error();
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
async function normalized(command: unknown, selected: PublicationPendingScope) {
  const parsed = await parseProductPublicationUserCommandV2(command);
  if (parsed.productReference !== selected.productReference || parsed.reasonCode !== "USER_REQUEST")
    return fail();
  const body = JSON.stringify(parsed);
  if (new TextEncoder().encode(body).byteLength > 8192) return fail();
  return { command: parsed, body };
}
/** Nonsecret original intent only. This digest is integrity, never authentication. */
export async function buildPublicationPendingRecordV2(
  command: unknown,
  selected: PublicationPendingScope,
) {
  try {
    const s = scope(selected),
      v = await normalized(command, s);
    const body = Object.freeze({
      profile: "CatalogProductPublicationPendingV2" as const,
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
export type PublicationPendingRecordV2 = Awaited<
  ReturnType<typeof buildPublicationPendingRecordV2>
>;
export async function parsePublicationPendingRecordV2(
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
      raw.profile !== "CatalogProductPublicationPendingV2" ||
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
    const v = await normalized(JSON.parse(raw.body), s);
    if (v.body !== raw.body || v.command.operationReference !== raw.operationReference)
      return fail();
    const rebuilt = await buildPublicationPendingRecordV2(v.command, s);
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
