import { Buffer } from "node:buffer";
import { createOperatingEntity, type OperatingEntity } from "../domain/operating-entity.js";

export const initialOwnerQualificationPurpose = "INITIAL_OWNER_ISSUANCE" as const;
export const initialOwnerQualificationSignatureDomain = "BOP-RMS:InitialOwnerQualificationV1\n";
export interface InitialOwnerQualificationCodec {
  canonicalize(value: unknown): string;
  sha256Hex(value: string): string;
}
export interface InitialOwnerEntityPin {
  readonly operatingEntityReference: string;
  readonly entityVersion: number;
  readonly entityDigest: string;
  readonly entityEvidenceReference: string;
  readonly reviewEvidenceReference: string;
  readonly materialDigest: string;
}
export interface InitialOwnerEmailPin {
  readonly evidenceReference: string;
  readonly operatingEntityReference: string;
  readonly emailDigest: string;
  readonly materialDigest: string;
}
export interface InitialOwnerQualificationExpected {
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly planDigest: string;
  readonly operatorReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly entity: InitialOwnerEntityPin;
  readonly email: InitialOwnerEmailPin;
}
export interface InitialOwnerQualification extends InitialOwnerQualificationExpected {
  readonly profile: "InitialOwnerQualificationV1";
  readonly purposeCode: typeof initialOwnerQualificationPurpose;
  readonly reviewerReference: string;
  readonly keyReference: string;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly signature: string;
}
export interface InitialOwnerQualificationTrustKey {
  readonly keyReference: string;
  readonly reviewerReference: string;
  readonly environmentReference: string;
  readonly purposeCode: typeof initialOwnerQualificationPurpose;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly publicKeySpki: string;
}
export interface InitialOwnerQualificationTrust {
  readonly profile: "InitialOwnerQualificationTrustV1";
  readonly keys: readonly InitialOwnerQualificationTrustKey[];
  readonly withdrawnEvidenceReferences: readonly string[];
  readonly revokedKeyReferences: readonly string[];
}
export class InitialOwnerQualificationError extends Error {
  readonly code = "INITIAL_OWNER_QUALIFICATION_UNAVAILABLE";
  constructor() { super("Initial Owner qualification is unavailable"); this.name = "InitialOwnerQualificationError"; }
}
export const initialOwnerQualificationFail = (): never => { throw new InitialOwnerQualificationError(); };
/** Internal owner descriptor parser; never evaluates accessors. */
export function initialOwnerQualificationRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length) return initialOwnerQualificationFail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return initialOwnerQualificationFail();
    result[field] = d.value;
  }
  return result;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) return initialOwnerQualificationFail();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return initialOwnerQualificationFail();
  return value;
}
export function parseInitialOwnerQualificationInstant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || value.startsWith("0000-") || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return initialOwnerQualificationFail();
  return value;
}
function dense(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return initialOwnerQualificationFail();
  const items: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return initialOwnerQualificationFail();
    items.push(d.value);
  }
  return items;
}
function binary(value: unknown, size: number): string {
  if (typeof value !== "string" || value.length !== Math.ceil(size * 4 / 3) || !/^[A-Za-z0-9_-]+$/u.test(value)) return initialOwnerQualificationFail();
  const data = Buffer.from(value, "base64url");
  if (data.length !== size || data.toString("base64url") !== value) return initialOwnerQualificationFail();
  return value;
}
export function parseInitialOwnerEntityPin(value: unknown): InitialOwnerEntityPin {
  const r = initialOwnerQualificationRecord(value, ["operatingEntityReference", "entityVersion", "entityDigest", "entityEvidenceReference", "reviewEvidenceReference", "materialDigest"]);
  if (typeof r.entityVersion !== "number" || !Number.isSafeInteger(r.entityVersion) || r.entityVersion < 1) return initialOwnerQualificationFail();
  return Object.freeze({operatingEntityReference: reference(r.operatingEntityReference), entityVersion: r.entityVersion, entityDigest: digest(r.entityDigest), entityEvidenceReference: reference(r.entityEvidenceReference), reviewEvidenceReference: reference(r.reviewEvidenceReference), materialDigest: digest(r.materialDigest)});
}
export function parseInitialOwnerEmailPin(value: unknown): InitialOwnerEmailPin {
  const r = initialOwnerQualificationRecord(value, ["evidenceReference", "operatingEntityReference", "emailDigest", "materialDigest"]);
  return Object.freeze({evidenceReference: reference(r.evidenceReference), operatingEntityReference: reference(r.operatingEntityReference), emailDigest: digest(r.emailDigest), materialDigest: digest(r.materialDigest)});
}
const expectedFields = ["environmentReference", "operationReference", "planDigest", "operatorReference", "actorReference", "brandReference", "entity", "email"];
function expected(r: Record<string, unknown>): InitialOwnerQualificationExpected {
  const entity = parseInitialOwnerEntityPin(r.entity), email = parseInitialOwnerEmailPin(r.email);
  if (entity.operatingEntityReference !== email.operatingEntityReference) return initialOwnerQualificationFail();
  return Object.freeze({environmentReference: reference(r.environmentReference), operationReference: reference(r.operationReference), planDigest: digest(r.planDigest), operatorReference: reference(r.operatorReference), actorReference: reference(r.actorReference), brandReference: reference(r.brandReference), entity, email});
}
export function parseInitialOwnerQualificationExpected(value: unknown): InitialOwnerQualificationExpected { return expected(initialOwnerQualificationRecord(value, expectedFields)); }
export function parseInitialOwnerQualification(value: unknown): InitialOwnerQualification {
  const r = initialOwnerQualificationRecord(value, [...expectedFields, "profile", "purposeCode", "reviewerReference", "keyReference", "notBefore", "validUntil", "signature"]), e = expected(r), reviewerReference = reference(r.reviewerReference), notBefore = parseInitialOwnerQualificationInstant(r.notBefore), validUntil = parseInitialOwnerQualificationInstant(r.validUntil);
  if (r.profile !== "InitialOwnerQualificationV1" || r.purposeCode !== initialOwnerQualificationPurpose || reviewerReference === e.operatorReference || reviewerReference === e.actorReference || validUntil <= notBefore) return initialOwnerQualificationFail();
  return Object.freeze({...e, profile: "InitialOwnerQualificationV1", purposeCode: initialOwnerQualificationPurpose, reviewerReference, keyReference: reference(r.keyReference), notBefore, validUntil, signature: binary(r.signature, 64)});
}
export function parseInitialOwnerQualificationTrust(value: unknown): InitialOwnerQualificationTrust {
  const r = initialOwnerQualificationRecord(value, ["profile", "keys", "withdrawnEvidenceReferences", "revokedKeyReferences"]);
  if (r.profile !== "InitialOwnerQualificationTrustV1") return initialOwnerQualificationFail();
  const keys = dense(r.keys, 32).map(value => {
    const k = initialOwnerQualificationRecord(value, ["keyReference", "reviewerReference", "environmentReference", "purposeCode", "notBefore", "validUntil", "publicKeySpki"]), notBefore = parseInitialOwnerQualificationInstant(k.notBefore), validUntil = parseInitialOwnerQualificationInstant(k.validUntil);
    if (k.purposeCode !== initialOwnerQualificationPurpose || validUntil <= notBefore) return initialOwnerQualificationFail();
    return Object.freeze({keyReference: reference(k.keyReference), reviewerReference: reference(k.reviewerReference), environmentReference: reference(k.environmentReference), purposeCode: initialOwnerQualificationPurpose, notBefore, validUntil, publicKeySpki: binary(k.publicKeySpki, 44)});
  }), withdrawnEvidenceReferences = dense(r.withdrawnEvidenceReferences, 256).map(reference), revokedKeyReferences = dense(r.revokedKeyReferences, 256).map(reference);
  if (new Set(keys.map(k => k.keyReference)).size !== keys.length || new Set(withdrawnEvidenceReferences).size !== withdrawnEvidenceReferences.length || new Set(revokedKeyReferences).size !== revokedKeyReferences.length) return initialOwnerQualificationFail();
  return Object.freeze({profile: "InitialOwnerQualificationTrustV1", keys: Object.freeze(keys), withdrawnEvidenceReferences: Object.freeze(withdrawnEvidenceReferences), revokedKeyReferences: Object.freeze(revokedKeyReferences)});
}
/** Signed review attestation only; cryptography does not establish legal facts. */
export function initialOwnerQualificationSigningBytes(value: unknown, codec: InitialOwnerQualificationCodec): string {
  const {signature, ...payload} = parseInitialOwnerQualification(value); void signature;
  return initialOwnerQualificationSignatureDomain + codec.canonicalize(payload);
}
/** Complete actual root, including all nullable references and lifecycle/time. */
export function hashInitialOwnerEntity(value: unknown, codec: InitialOwnerQualificationCodec): string {
  const entity: OperatingEntity = createOperatingEntity(value), hex = codec.sha256Hex(codec.canonicalize(entity));
  return digest(`sha256:${hex}`);
}
