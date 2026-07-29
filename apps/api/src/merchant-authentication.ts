import {
  assertSessionUsable,
  createIdentityActor,
  parseCanonicalInstant,
  parseSessionReference,
  type IdentityActor,
  type IdentitySessionPort,
} from "@bop/identity";
import {
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  type MembershipPort,
} from "@bop/membership";
import {
  evaluatePermission,
  materializePermissionEvidence,
  parseBusinessAction,
  type BusinessAction,
  type PermissionPolicyPort,
} from "@bop/permission";
import type { Request, RequestHandler } from "express";
import { getTenantContext, type AuthenticatedActorResolver } from "./tenant-context.js";

export type SessionReferenceResolver = (request: Request) => unknown | Promise<unknown>;

export interface MerchantAuthenticatedActorResolverOptions {
  readonly identitySessionPort: IdentitySessionPort;
  readonly now?: () => unknown;
  readonly resolveSessionReference: SessionReferenceResolver;
}

export function createMerchantAuthenticatedActorResolver({
  identitySessionPort,
  now = () => new Date().toISOString(),
  resolveSessionReference,
}: MerchantAuthenticatedActorResolverOptions): AuthenticatedActorResolver {
  return async (request) => {
    const candidate = await resolveSessionReference(request);
    if (candidate === null || candidate === undefined) return null;
    const observedAt = parseCanonicalInstant(now());
    const sessionReference = parseSessionReference(candidate);
    const session = await identitySessionPort.resolveSession({ sessionReference, observedAt });
    if (!Object.isFrozen(session) || session.sessionReference !== sessionReference)
      throw new Error("MERCHANT_AUTHENTICATION_DENIED");
    assertSessionUsable(session, observedAt);
    const actor: IdentityActor = createIdentityActor(session.actor);
    if (
      actor.actorType !== "User" ||
      actor.accountKind !== "Workforce" ||
      actor.authenticationMethod !== "Oidc" ||
      actor.actorReference === null ||
      actor.authenticatedAt !== session.authenticatedAt
    )
      throw new Error("MERCHANT_AUTHENTICATION_DENIED");
    return actor;
  };
}

export interface MerchantPermissionMiddlewareOptions {
  readonly action: unknown;
  readonly membershipPort: MembershipPort;
  readonly permissionPolicyPort: PermissionPolicyPort;
  readonly requireStoreScope: boolean;
}

function deny(response: Parameters<RequestHandler>[1]): void {
  response.status(403).json(Object.freeze({ error: "permission_denied" }));
}

export function createMerchantPermissionMiddleware({
  action: actionInput,
  membershipPort,
  permissionPolicyPort,
  requireStoreScope,
}: MerchantPermissionMiddlewareOptions): RequestHandler {
  const action: BusinessAction = parseBusinessAction(actionInput);
  return (request, response, next) => {
    void (async () => {
      try {
        const tenantContext = getTenantContext(request);
        if (requireStoreScope && tenantContext.store === null) {
          deny(response);
          return;
        }
        const actorReference = tenantContext.actor.actorReference;
        if (actorReference === null) throw new Error("MERCHANT_PERMISSION_DENIED");
        const memberships = await membershipPort.findMemberships(
          actorReference,
          tenantContext.brand.brandReference,
        );
        const membership = resolveActiveMembership(
          memberships,
          actorReference,
          tenantContext.brand.brandReference,
          tenantContext.resolvedAt,
        );
        const storeAssignment =
          tenantContext.store === null
            ? null
            : resolveActiveStoreAssignment(
                membership,
                await membershipPort.findStoreAssignments(
                  membership.membershipReference,
                  tenantContext.store.storeReference,
                ),
                tenantContext.store.storeReference,
                tenantContext.resolvedAt,
              );
        const snapshot = await permissionPolicyPort.loadPolicySnapshot(
          tenantContext.brand.brandReference,
        );
        if (snapshot === null) throw new Error("MERCHANT_PERMISSION_DENIED");
        const materialization = materializePermissionEvidence(
          Object.freeze({
            tenantContext,
            policyState: snapshot.state,
            membership,
            storeAssignment,
            permissionDefinitions: snapshot.permissionDefinitions,
            roles: snapshot.roles,
            roleAssignments: snapshot.roleAssignments,
            permissionGrants: snapshot.permissionGrants,
            permissionOverrides: snapshot.permissionOverrides,
          }),
        );
        const decision = evaluatePermission({
          tenantContext,
          action,
          resourceScope: Object.freeze({
            kind: tenantContext.scopeKind,
            brandReference: tenantContext.brand.brandReference,
            storeReference: tenantContext.store?.storeReference ?? null,
          }),
          policySnapshotReference: materialization.policySnapshotReference,
          policyVersion: materialization.policyVersion,
          evidence: materialization.evidence,
        });
        if (decision.effect !== "Allow") {
          deny(response);
          return;
        }
        next();
      } catch {
        deny(response);
      }
    })();
  };
}
