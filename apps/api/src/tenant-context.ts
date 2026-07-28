import { createIdentityActor, type ActorReference, type IdentityActor } from "@bop/identity";
import {
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  type MembershipPort,
} from "@bop/membership";
import {
  createBrand,
  createStore,
  createTenantContext,
  parseBrandReference,
  parseCanonicalInstant,
  parseStoreReference,
  type Brand,
  type Store,
  type TenantContext,
  type TenantOrganizationPort,
} from "@bop/tenant";
import type { Request, RequestHandler } from "express";

const tenantContextKey = Symbol("bop.tenant-context");

type RequestWithTenantContext = Request & {
  [tenantContextKey]?: TenantContext;
};

export type AuthenticatedActorResolver = (
  request: Request,
) => IdentityActor | null | Promise<IdentityActor | null>;

interface CommonTenantContextMiddlewareOptions {
  readonly resolveAuthenticatedActor: AuthenticatedActorResolver;
  readonly membershipPort: MembershipPort;
  readonly now?: () => unknown;
  readonly tenantOrganizationPort: TenantOrganizationPort;
}

export interface BrandTenantContextMiddlewareOptions extends CommonTenantContextMiddlewareOptions {
  readonly scopeKind: "Brand";
  readonly brandParameter: string;
}

export interface StoreTenantContextMiddlewareOptions extends CommonTenantContextMiddlewareOptions {
  readonly scopeKind: "Store";
  readonly storeParameter: string;
  readonly brandParameter?: string;
}

export type TenantContextMiddlewareOptions =
  BrandTenantContextMiddlewareOptions | StoreTenantContextMiddlewareOptions;

function routeParameter(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string") throw new Error("TENANT_ROUTE_PARAMETER_INVALID");
  return value;
}

function authenticateWorkforceActor(input: IdentityActor): IdentityActor & {
  readonly actorReference: ActorReference;
} {
  const actor = createIdentityActor(input);
  if (
    actor.actorType !== "User" ||
    actor.accountKind !== "Workforce" ||
    actor.actorReference === null
  )
    throw new Error("TENANT_ACTOR_DENIED");
  return actor as IdentityActor & { readonly actorReference: ActorReference };
}

function deny(request: Request, status: 401 | 403, code: string): void {
  const response = request.res;
  if (response === undefined || response.headersSent) return;
  response.status(status).json(Object.freeze({ error: code }));
}

async function resolveOrganization(
  request: Request,
  options: TenantContextMiddlewareOptions,
): Promise<readonly [Brand, Store | null]> {
  if (options.scopeKind === "Brand") {
    const brandReference = parseBrandReference(routeParameter(request, options.brandParameter));
    const brandInput = await options.tenantOrganizationPort.getBrand(brandReference);
    if (brandInput === null) throw new Error("TENANT_ORGANIZATION_DENIED");
    const brand = createBrand(brandInput);
    if (brand.lifecycle !== "Active") throw new Error("TENANT_ORGANIZATION_DENIED");
    return [brand, null];
  }

  const storeReference = parseStoreReference(routeParameter(request, options.storeParameter));
  const storeInput = await options.tenantOrganizationPort.getStore(storeReference);
  if (storeInput === null) throw new Error("TENANT_ORGANIZATION_DENIED");
  const store = createStore(storeInput);
  if (store.lifecycle !== "Active") throw new Error("TENANT_ORGANIZATION_DENIED");
  if (
    options.brandParameter !== undefined &&
    parseBrandReference(routeParameter(request, options.brandParameter)) !== store.brandReference
  )
    throw new Error("TENANT_ORGANIZATION_DENIED");
  const brandInput = await options.tenantOrganizationPort.getBrand(store.brandReference);
  if (brandInput === null) throw new Error("TENANT_ORGANIZATION_DENIED");
  const brand = createBrand(brandInput);
  if (brand.lifecycle !== "Active") throw new Error("TENANT_ORGANIZATION_DENIED");
  return [brand, store];
}

export function getTenantContext(request: Request): TenantContext {
  const context = (request as RequestWithTenantContext)[tenantContextKey];
  if (context === undefined) throw new Error("TENANT_CONTEXT_UNAVAILABLE");
  return context;
}

export function createTenantContextMiddleware(
  options: TenantContextMiddlewareOptions,
): RequestHandler {
  return (request, response, next) => {
    void (async () => {
      let actorInput: IdentityActor | null;
      try {
        actorInput = await options.resolveAuthenticatedActor(request);
      } catch {
        deny(request, 401, "authentication_required");
        return;
      }
      if (actorInput === null) {
        deny(request, 401, "authentication_required");
        return;
      }

      let context: TenantContext;
      try {
        const actor = authenticateWorkforceActor(actorInput);
        const resolvedAt = parseCanonicalInstant(
          (options.now ?? (() => new Date().toISOString()))(),
        );
        const [brand, store] = await resolveOrganization(request, options);
        const memberships = await options.membershipPort.findMemberships(
          actor.actorReference,
          brand.brandReference,
        );
        const membership = resolveActiveMembership(
          memberships,
          actor.actorReference,
          brand.brandReference,
          resolvedAt,
        );
        if (store !== null) {
          const assignments = await options.membershipPort.findStoreAssignments(
            membership.membershipReference,
            store.storeReference,
          );
          resolveActiveStoreAssignment(membership, assignments, store.storeReference, resolvedAt);
        }
        context = createTenantContext(actor, brand, store, resolvedAt);
      } catch {
        deny(request, 403, "tenant_context_denied");
        return;
      }

      const localRequest = request as RequestWithTenantContext;
      Object.defineProperty(localRequest, tenantContextKey, {
        configurable: true,
        enumerable: false,
        value: context,
        writable: false,
      });
      let completed = false;
      const cleanup = () => {
        if (completed) return;
        completed = true;
        response.off("finish", cleanup);
        response.off("close", cleanup);
        Reflect.deleteProperty(localRequest, tenantContextKey);
      };
      response.once("finish", cleanup);
      response.once("close", cleanup);
      next();
    })();
  };
}
