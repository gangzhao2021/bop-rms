import { parseBusinessAction, type BusinessAction } from "@bop/permission";
import {
  parseBrandReference,
  parseStoreReference,
  type BrandReference,
  type StoreReference,
  type TenantContext,
  type TenantScopeKind,
} from "@bop/tenant";
import type { Request, RequestHandler } from "express";
import { getTenantContext } from "./tenant-context.js";

const objectScopeKey = Symbol("bop.object-authorization-scope");
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const evidenceKeys = [
  "objectReference",
  "scopeKind",
  "brandReference",
  "storeReference",
  "version",
] as const;

export type ObjectReference = string & { readonly __objectReference: unique symbol };
export type ObjectVersion = number & { readonly __objectVersion: unique symbol };

export interface ObjectAuthorizationEvidence {
  readonly objectReference: ObjectReference;
  readonly scopeKind: TenantScopeKind;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
  readonly version: ObjectVersion;
}

export interface ResolveObjectAuthorizationQuery {
  readonly tenantContext: TenantContext;
  readonly action: BusinessAction;
  readonly objectReference: ObjectReference;
}

export type ObjectAuthorizationResolver = (
  query: ResolveObjectAuthorizationQuery,
) => Promise<unknown | null>;

type RequestWithObjectScope = Request & {
  [objectScopeKey]?: ObjectAuthorizationEvidence;
};

export interface MerchantObjectAuthorizationMiddlewareOptions {
  readonly action: unknown;
  readonly objectParameter: string;
  readonly resolveObjectAuthorization: ObjectAuthorizationResolver;
}

function closedRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value)
  )
    throw new Error("OBJECT_AUTHORIZATION_DENIED");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== evidenceKeys.length ||
    keys.some((key) => typeof key !== "string" || !evidenceKeys.includes(key as never))
  )
    throw new Error("OBJECT_AUTHORIZATION_DENIED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const key of evidenceKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("OBJECT_AUTHORIZATION_DENIED");
    record[key] = descriptor.value;
  }
  return record;
}

export function parseObjectReference(value: unknown): ObjectReference {
  if (typeof value !== "string" || !uuidV7Pattern.test(value))
    throw new Error("OBJECT_AUTHORIZATION_DENIED");
  return value as ObjectReference;
}

function parseObjectVersion(value: unknown): ObjectVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error("OBJECT_AUTHORIZATION_DENIED");
  return value as ObjectVersion;
}

export function createObjectAuthorizationEvidence(value: unknown): ObjectAuthorizationEvidence {
  const record = closedRecord(value);
  const scopeKind = record.scopeKind;
  if (scopeKind !== "Brand" && scopeKind !== "Store")
    throw new Error("OBJECT_AUTHORIZATION_DENIED");
  const storeReference =
    record.storeReference === null ? null : parseStoreReference(record.storeReference);
  if (
    (scopeKind === "Brand" && storeReference !== null) ||
    (scopeKind === "Store" && storeReference === null)
  )
    throw new Error("OBJECT_AUTHORIZATION_DENIED");
  return Object.freeze({
    objectReference: parseObjectReference(record.objectReference),
    scopeKind,
    brandReference: parseBrandReference(record.brandReference),
    storeReference,
    version: parseObjectVersion(record.version),
  });
}

function matchesContext(evidence: ObjectAuthorizationEvidence, context: TenantContext): boolean {
  if (evidence.brandReference !== context.brand.brandReference) return false;
  if (evidence.scopeKind === "Brand") return true;
  return context.store !== null && evidence.storeReference === context.store.storeReference;
}

function deny(response: Parameters<RequestHandler>[1]): void {
  response.status(403).json(Object.freeze({ error: "object_access_denied" }));
}

export function getObjectAuthorizationEvidence(request: Request): ObjectAuthorizationEvidence {
  const evidence = (request as RequestWithObjectScope)[objectScopeKey];
  if (evidence === undefined) throw new Error("OBJECT_AUTHORIZATION_DENIED");
  return evidence;
}

export function createMerchantObjectAuthorizationMiddleware({
  action: actionInput,
  objectParameter,
  resolveObjectAuthorization,
}: MerchantObjectAuthorizationMiddlewareOptions): RequestHandler {
  const action = parseBusinessAction(actionInput);
  return (request, response, next) => {
    void (async () => {
      try {
        const tenantContext = getTenantContext(request);
        const objectReference = parseObjectReference(request.params[objectParameter]);
        const candidate = await resolveObjectAuthorization({
          tenantContext,
          action,
          objectReference,
        });
        if (candidate === null) throw new Error("OBJECT_AUTHORIZATION_DENIED");
        const evidence = createObjectAuthorizationEvidence(candidate);
        if (
          evidence.objectReference !== objectReference ||
          !matchesContext(evidence, tenantContext)
        )
          throw new Error("OBJECT_AUTHORIZATION_DENIED");

        const localRequest = request as RequestWithObjectScope;
        Object.defineProperty(localRequest, objectScopeKey, {
          configurable: true,
          enumerable: false,
          value: evidence,
          writable: false,
        });
        let completed = false;
        const cleanup = () => {
          if (completed) return;
          completed = true;
          response.off("finish", cleanup);
          response.off("close", cleanup);
          Reflect.deleteProperty(localRequest, objectScopeKey);
        };
        response.once("finish", cleanup);
        response.once("close", cleanup);
        next();
      } catch {
        deny(response);
      }
    })();
  };
}
