import {
  assertSessionUsable,
  merchantSessionCookie,
  parseCanonicalInstant,
  parseRawBrowserCredential,
  type AuthenticationSession,
  type BrowserCookieMutation,
} from "@bop/identity";
import {
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  type CurrentMembershipReadPort,
} from "@bop/membership";
import {
  createBrand,
  createStore,
  createTenantContext,
  parseStoreReference,
  type TenantContext,
  type TenantOrganizationPort,
} from "@bop/tenant";

export interface StoreContextSessionPort {
  authorize(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
  }): Promise<AuthenticationSession>;
  rotate(
    sessionCookie: unknown,
    reason: "StoreContextElevation",
  ): Promise<{
    readonly session: AuthenticationSession;
    readonly cookie: BrowserCookieMutation;
  }>;
}

export interface MerchantStoreSwitchServiceOptions {
  readonly membershipPort: CurrentMembershipReadPort;
  readonly now?: () => unknown;
  readonly sessionPort: StoreContextSessionPort;
  readonly tenantOrganizationPort: Pick<TenantOrganizationPort, "getBrand" | "getStore">;
}

export interface MerchantStoreSwitchInput {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly targetStoreReference: unknown;
}

export interface MerchantStoreSwitchResult {
  readonly cookie: BrowserCookieMutation;
  readonly tenantContext: TenantContext;
}

function workforceActor(
  session: AuthenticationSession,
): NonNullable<AuthenticationSession["actor"]["actorReference"]> {
  const actor = session.actor;
  if (
    !Object.isFrozen(session) ||
    !Object.isFrozen(actor) ||
    actor.actorType !== "User" ||
    actor.accountKind !== "Workforce" ||
    actor.actorReference === null ||
    actor.status !== "Active"
  )
    throw new Error("STORE_SWITCH_DENIED");
  return actor.actorReference;
}

function validateRotation(
  current: AuthenticationSession,
  result: Awaited<ReturnType<StoreContextSessionPort["rotate"]>>,
  observedAt: ReturnType<typeof parseCanonicalInstant>,
): MerchantStoreSwitchResult["cookie"] {
  const next = result.session;
  const cookie = result.cookie;
  const descriptor = cookie.descriptor;
  if (
    !Object.isFrozen(result) ||
    !Object.isFrozen(next) ||
    !Object.isFrozen(cookie) ||
    !Object.isFrozen(descriptor) ||
    workforceActor(next) !== current.actor.actorReference ||
    next.sessionReference === current.sessionReference ||
    next.rotatedFromSessionReference !== current.sessionReference ||
    next.version !== current.version + 1 ||
    cookie.clear ||
    descriptor.name !== merchantSessionCookie.name ||
    descriptor.secure !== true ||
    descriptor.httpOnly !== true ||
    descriptor.sameSite !== "lax" ||
    descriptor.path !== "/" ||
    descriptor.maxAgeSeconds !== null
  )
    throw new Error("STORE_SWITCH_DENIED");
  parseRawBrowserCredential(cookie.value);
  assertSessionUsable(next, observedAt);
  return cookie;
}

export class MerchantStoreSwitchService {
  readonly #membershipPort: CurrentMembershipReadPort;
  readonly #now: () => unknown;
  readonly #sessionPort: StoreContextSessionPort;
  readonly #tenantOrganizationPort: Pick<TenantOrganizationPort, "getBrand" | "getStore">;

  constructor({
    membershipPort,
    now = () => new Date().toISOString(),
    sessionPort,
    tenantOrganizationPort,
  }: MerchantStoreSwitchServiceOptions) {
    this.#membershipPort = membershipPort;
    this.#now = now;
    this.#sessionPort = sessionPort;
    this.#tenantOrganizationPort = tenantOrganizationPort;
  }

  async switchStore(input: MerchantStoreSwitchInput): Promise<MerchantStoreSwitchResult> {
    try {
      const observedAt = parseCanonicalInstant(this.#now());
      const current = await this.#sessionPort.authorize({
        sessionCookie: input.sessionCookie,
        csrf: input.csrf,
      });
      assertSessionUsable(current, observedAt);
      const targetStoreReference = parseStoreReference(input.targetStoreReference);
      const tenantPort = this.#tenantOrganizationPort;
      const membershipPort = this.#membershipPort;
      async function resolveTarget(
        session: AuthenticationSession,
        observedAt: ReturnType<typeof parseCanonicalInstant>,
      ) {
        const actorReference = workforceActor(session);

        const storeInput = await tenantPort.getStore(targetStoreReference);
        if (storeInput === null) throw new Error("STORE_SWITCH_DENIED");
        const store = createStore(storeInput);
        if (store.lifecycle !== "Active") throw new Error("STORE_SWITCH_DENIED");
        const brandInput = await tenantPort.getBrand(store.brandReference);
        if (brandInput === null) throw new Error("STORE_SWITCH_DENIED");
        const brand = createBrand(brandInput);
        if (brand.lifecycle !== "Active") throw new Error("STORE_SWITCH_DENIED");

        const membership = resolveActiveMembership(
          await membershipPort.findMemberships(actorReference, brand.brandReference),
          actorReference,
          brand.brandReference,
          observedAt,
        );
        resolveActiveStoreAssignment(
          membership,
          await membershipPort.findStoreAssignments(
            membership.membershipReference,
            store.storeReference,
          ),
          store.storeReference,
          observedAt,
        );
        return createTenantContext(session.actor, brand, store, observedAt);
      }
      await resolveTarget(current, observedAt);

      const rotated = await this.#sessionPort.rotate(input.sessionCookie, "StoreContextElevation");
      const refreshedAt = parseCanonicalInstant(this.#now());
      const cookie = validateRotation(current, rotated, refreshedAt);
      const tenantContext = await resolveTarget(rotated.session, refreshedAt);
      return Object.freeze({
        cookie,
        tenantContext,
      });
    } catch {
      throw new Error("STORE_SWITCH_DENIED");
    }
  }
}
