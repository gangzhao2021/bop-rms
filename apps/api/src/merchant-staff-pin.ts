import {
  checkStaffPin,
  endStaffPinSessionsOnDevice,
  findStoreSignInDevice,
  generateStoreDeviceSecret,
  listStoreSignInDevices,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readStaffPinSession,
  readStaffPinStates,
  recordStaffPinSession,
  registerStoreSignInDevice,
  resetStaffPin,
  revokeStoreSignInDevice,
  setStaffPin,
  type AuthenticationSession,
  parseRawBrowserCredential,
  type StaffPinChoiceTokens,
  type StaffPinKdf,
  type StaffPinProblem,
  type StaffPinState,
  type StoreDeviceSecretHasher,
} from "@bop/identity";
import {
  listStoreMembers,
  memberDisplayNames,
  type MemberDirectoryTransaction,
  type StoreMember,
} from "@bop/membership";
import type { RoleAssignmentTransaction } from "@bop/permission";
import { createStaffLabels, distinctStaffLabels } from "./merchant-staff-labels.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * WP-2423 Q18 option A (DEC-STAFF-SESSION-CONTINUITY section 5, Owner 2026-10-14): staff switch on
 * a shared Store tablet with a device-bound six-digit PIN.
 *
 * - A manager signed in fully (identity.store_device.manage) registers the tablet they are using;
 *   its secret goes to an HttpOnly cookie only, the database keeps a keyed hash.
 * - A staff member signed in fully (merchant.access) sets their own PIN at the selected Store.
 * - On a registered, unrevoked tablet the lock screen lists the Store's active members who have a
 *   PIN, each named by an opaque per-tablet token (never the actor reference); a correct PIN
 *   issues that person's ordinary WorkforceStandard session, recorded as PIN-issued, and ends the
 *   tablet's previous session. A full sign-in on the tablet also ends its PIN sessions.
 * - A manager (identity.staff_pin.reset) resets a PIN; the person sets a new one after a full
 *   sign-in. A PIN session cannot register/remove tablets, reset or set PINs (and the BFF refuses
 *   other sensitive actions) until it is verified with the MFA step-up or replaced by a full sign-in.
 */
export class MerchantStaffPinError extends Error {
  constructor(
    readonly code:
      | "Denied"
      | "FullSignInRequired"
      | "DeviceNotRegistered"
      | "NotFound"
      | "AlreadyRegistered"
      | "NotSet"
      /** The lock-screen choice names nobody on this tablet now (list changed or not genuine). */
      | "NotListed"
      | "Unavailable",
  ) {
    super(code);
    this.name = "MerchantStaffPinError";
  }
}
const fail = (code: MerchantStaffPinError["code"]): never => {
  throw new MerchantStaffPinError(code);
};
interface Query {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface StaffPinStoreProfile {
  readonly label: string;
  readonly timeZone: string;
}
export interface StaffPinView {
  readonly state: StaffPinState;
  readonly changedAt: string | null;
  readonly lockedUntil: string | null;
}
export type StaffSwitchResult =
  | { readonly status: "SignedIn"; readonly sessionCookie: string }
  | { readonly status: "Rejected" }
  | { readonly status: "Locked"; readonly lockedUntil: string }
  | { readonly status: "Throttled"; readonly retryAfterSeconds: number };

const DEVICE_COOKIE = /^[A-Za-z0-9_-]{43}$/u;
/** A Store order number as staff see it (the browser keeps only these and deadlines). */
const ORDER_NUMBER = /^[A-Za-z0-9-]{1,20}$/u;
/** At most this many remembered orders are re-checked in one request. */
export const REFUND_RECHECK_MAX_ORDERS = 10;
export interface TabletRefundRecheck {
  readonly checkedAt: string;
  /** Each asked order; `acceptBy` is null once it no longer waits (accepted, refunded, closed). */
  readonly orders: readonly { readonly orderNumber: string; readonly acceptBy: string | null }[];
}
const CHOICE = /^[A-Za-z0-9_-]{43}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const active = (member: StoreMember) =>
  member.membershipLifecycle === "Active" && member.assignmentLifecycle === "Active";
const notSet: StaffPinView = Object.freeze({ state: "NotSet", changedAt: null, lockedUntil: null });

export function createMerchantStaffPin(options: {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly deviceHasher: StoreDeviceSecretHasher;
  readonly kdf: StaffPinKdf;
  /** Opaque per-tablet names of the people on the lock screen (server-held key). */
  readonly choiceTokens: StaffPinChoiceTokens;
  newReference(): string;
  /** The Store's name and time zone for the lock screen (no session there). */
  describeStore(
    tx: Query,
    scope: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly at: string;
    },
  ): Promise<StaffPinStoreProfile>;
  /**
   * Creates the staff member's ordinary WorkforceStandard session the way the sign-in does
   * (current Actor, Store selection) and runs `finalize` inside the same transaction.
   */
  issueSession(
    actorReference: string,
    finalize: (tx: Query, session: AuthenticationSession) => Promise<void>,
  ): Promise<{ readonly sessionCookie: string }>;
  /**
   * v15 cbff9d6f: today's paid pickup orders still waiting for acceptance at the tablet's Store,
   * with their refund deadlines (see `createStoreAwaitingPickupDeadlines`). Without it the tablet
   * cannot re-check a remembered refund countdown and the screen says it may be out of date.
   */
  awaitingPickupDeadlines?(
    tx: Query,
    scope: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly timeZone: string;
      readonly at: string;
    },
  ): Promise<readonly { readonly orderNumber: string; readonly acceptBy: string }[]>;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}) {
  const persistence = options.persistence;
  const resolve = createMerchantStoreScope(persistence);
  const policy = {
    retentionPolicyCode: options.retentionPolicyCode,
    retentionPolicyVersion: options.retentionPolicyVersion,
  };
  const now = () => String(parseCanonicalInstant(persistence.now()));
  const reference = () =>
    String(parseOpaqueUuidV7(options.newReference(), "ACTOR_REFERENCE_INVALID"));
  type Tx = Parameters<Parameters<typeof persistence.transactions.run>[0]>[0];
  const run = <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
    persistence.transactions.run(work).catch((error: unknown) => {
      if (error instanceof MerchantStaffPinError) throw error;
      // Lock/serialization conflicts are retried by the caller (see the HTTP routes).
      const code =
        error !== null && typeof error === "object"
          ? Object.getOwnPropertyDescriptor(error, "code")?.value
          : undefined;
      if (code === "TENANT_DATABASE_TRANSACTION_CONFLICT") throw error;
      throw new MerchantStaffPinError("Unavailable");
    });
  const directory = (tx: Tx) => tx as unknown as MemberDirectoryTransaction;
  const deviceHash = (cookie: unknown): string | null =>
    typeof cookie === "string" && DEVICE_COOKIE.test(cookie)
      ? options.deviceHasher.hash(cookie)
      : null;
  async function tablet(tx: Query, cookie: unknown) {
    const hash = deviceHash(cookie);
    if (hash === null) return null;
    const found = await findStoreSignInDevice(tx, { selectorHash: hash });
    return found !== null && found.active ? found : null;
  }
  async function scopeFor(
    tx: Tx,
    sessionCookie: unknown,
    action: string,
    expectedSession?: string,
  ) {
    let scope: Awaited<ReturnType<typeof resolve>>;
    try {
      scope = await resolve(tx, sessionCookie, action, expectedSession);
    } catch {
      return fail("Denied");
    }
    return scope;
  }
  const may = async (scope: Awaited<ReturnType<typeof scopeFor>>, action: string) =>
    (await scope.authorizeAction(action).catch(() => null))?.effect === "Allow";
  const where = (scope: Awaited<ReturnType<typeof scopeFor>>) => ({
    brandReference: String(scope.context.brand.brandReference),
    storeReference: String(scope.store.storeReference),
  });
  /** A PIN session may do this only after a recent step-up in that session. */
  async function requireFullSignIn(tx: Tx, sessionReference: string, at: string) {
    const pin = await readStaffPinSession(tx, { sessionReference, at });
    if (pin.pinIssued && pin.verifiedUntil === null) fail("FullSignInRequired");
  }
  async function activeMembers(tx: Tx, scope: { brandReference: string; storeReference: string }) {
    return (await listStoreMembers(directory(tx), scope)).filter(active);
  }
  /** Labels for the given people and anyone in `others` (never dropped for a missing name). */
  async function labelsFor(
    tx: Tx,
    scope: { brandReference: string; storeReference: string },
    input: {
      readonly viewer: string | null;
      readonly at: string;
      readonly members: readonly StoreMember[];
      readonly others?: readonly string[];
    },
  ) {
    const names = new Map<string, string | null>(
      input.members.map((member) => [member.actorReference, member.displayName]),
    );
    const missing = (input.others ?? []).filter((actor) => !names.has(actor));
    for (const [actor, name] of await memberDisplayNames(directory(tx), scope, missing))
      names.set(actor, name);
    return createStaffLabels(tx as unknown as RoleAssignmentTransaction, scope, {
      viewer: input.viewer,
      at: input.at,
      names,
    });
  }
  const authorize = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("Denied"));

  type SignedInSession = Pick<AuthenticationSession, "sessionReference" | "actor" | "createdAt">;
  async function endTabletPinSessions(
    tx: Query,
    deviceCookie: unknown,
    session: SignedInSession,
  ): Promise<{ readonly signedOut: number }> {
    const device = await tablet(tx, deviceCookie);
    if (device === null || session.actor.actorReference === null) return { signedOut: 0 };
    return endStaffPinSessionsOnDevice(
      tx,
      {
        brandReference: device.brandReference,
        storeReference: device.storeReference,
        deviceReference: device.deviceReference,
        sessionReference: session.sessionReference,
        actorReference: session.actor.actorReference,
        at: session.createdAt,
        auditReference: reference(),
      },
      policy,
    );
  }

  return Object.freeze({
    /** Whether this browser holds a registered, unrevoked Store tablet cookie. */
    async isRegisteredDevice(deviceCookie: unknown): Promise<boolean> {
      if (deviceHash(deviceCookie) === null) return false;
      return run(async (tx) => (await tablet(tx, deviceCookie)) !== null);
    },

    /** The lock screen: the Store and its active members who have a PIN (names only). */
    async switchScreen(deviceCookie: unknown) {
      return run(async (tx) => {
        const device = await tablet(tx, deviceCookie);
        if (device === null) return fail("DeviceNotRegistered");
        const scope = {
          brandReference: device.brandReference,
          storeReference: device.storeReference,
        };
        const at = now();
        const members = await activeMembers(tx, scope);
        const states =
          members.length === 0
            ? new Map()
            : await readStaffPinStates(tx, {
                ...scope,
                at,
                actorReferences: members.map((member) => member.actorReference),
              });
        const withPin = members.filter(
          (member) => states.get(member.actorReference)?.state === "Set",
        );
        // Nobody is signed in on the lock screen: everyone is named, nobody is "You".
        const label = await labelsFor(tx, scope, { viewer: null, at, members: withPin });
        const labels = distinctStaffLabels(
          withPin.map((member) => ({
            actorReference: member.actorReference,
            label: label(member.actorReference),
          })),
        );
        const profile = await options.describeStore(tx, { ...scope, at });
        const named = { ...scope, deviceReference: device.deviceReference };
        return Object.freeze({
          storeLabel: profile.label,
          timeZone: profile.timeZone,
          staff: withPin
            .map((member) =>
              Object.freeze({
                choice: options.choiceTokens.issue(named, member.actorReference),
                name: labels.get(member.actorReference) ?? "Staff member",
              }),
            )
            .sort((a, b) => a.name.localeCompare(b.name, "en")),
        });
      });
    },

    /**
     * v15 cbff9d6f (DEC-STAFF-SESSION-CONTINUITY 2026-10-17 correction): with nobody signed in, a
     * registered Store tablet asks whether the paid orders it was already warning about still wait
     * for acceptance, so its lock screen or signed-out cover stops counting down (and chiming) for
     * an order someone accepted elsewhere. Authorized only by the tablet binding; answers only for
     * the order numbers asked (no list of the Store's orders), with numbers and times only — no
     * Customer, item or payment details. A read: not audited (the HTTP route rate-limits it).
     */
    async refundRecheck(
      deviceCookie: unknown,
      orderNumbers: unknown,
    ): Promise<TabletRefundRecheck> {
      if (
        !Array.isArray(orderNumbers) ||
        orderNumbers.length === 0 ||
        orderNumbers.length > REFUND_RECHECK_MAX_ORDERS ||
        orderNumbers.some((value) => typeof value !== "string" || !ORDER_NUMBER.test(value)) ||
        new Set(orderNumbers).size !== orderNumbers.length
      )
        return fail("Denied");
      const asked = orderNumbers as readonly string[];
      const read = options.awaitingPickupDeadlines;
      if (read === undefined) return fail("Unavailable");
      return run(async (tx) => {
        const device = await tablet(tx, deviceCookie);
        if (device === null) return fail("DeviceNotRegistered");
        const scope = {
          brandReference: device.brandReference,
          storeReference: device.storeReference,
        };
        const at = now();
        const profile = await options.describeStore(tx, { ...scope, at });
        const waiting = await read(tx, { ...scope, timeZone: profile.timeZone, at });
        const soonest = new Map<string, string>();
        for (const order of waiting) {
          const known = soonest.get(order.orderNumber);
          if (known === undefined || Date.parse(order.acceptBy) < Date.parse(known))
            soonest.set(order.orderNumber, order.acceptBy);
        }
        return Object.freeze({
          checkedAt: at,
          orders: Object.freeze(
            asked.map((orderNumber) =>
              Object.freeze({ orderNumber, acceptBy: soonest.get(orderNumber) ?? null }),
            ),
          ),
        });
      });
    },

    /** A staff member's PIN on this tablet; a correct PIN signs them in here. */
    async unlock(input: {
      readonly deviceCookie: unknown;
      readonly sessionCookie: unknown;
      readonly choice: unknown;
      readonly pin: unknown;
    }): Promise<StaffSwitchResult> {
      if (typeof input.choice !== "string" || !CHOICE.test(input.choice)) return fail("Denied");
      const token = input.choice;
      const attemptReference = reference(),
        auditReference = reference(),
        lockAuditReference = reference();
      const checked = await run(async (tx) => {
        const device = await tablet(tx, input.deviceCookie);
        if (device === null) return fail("DeviceNotRegistered");
        const scope = {
          brandReference: device.brandReference,
          storeReference: device.storeReference,
        };
        // The token names one of this Store's current people on this tablet; anything else (someone
        // who has left, another tablet's list, a made-up value) names nobody and checks no PIN.
        const members = await listStoreMembers(directory(tx), scope);
        const choice = options.choiceTokens.resolve(
          { ...scope, deviceReference: device.deviceReference },
          token,
          members.map((member) => member.actorReference),
        );
        if (choice === null) return fail("NotListed");
        // Someone no longer working here is treated exactly like a person without a PIN.
        const eligible = members.some(
          (member) => member.actorReference === choice && active(member),
        );
        const result = await checkStaffPin(
          tx,
          {
            ...scope,
            deviceReference: device.deviceReference,
            actorReference: choice,
            eligible,
            pin: input.pin,
            at: now(),
            attemptReference,
            auditReference,
            lockAuditReference,
          },
          options.kdf,
          policy,
        );
        return { result, device, choice };
      });
      const { result, device, choice } = checked;
      if (result.status === "DeviceInactive") return fail("DeviceNotRegistered");
      if (result.status !== "Verified") return result;
      let previous: string | null = null;
      try {
        previous =
          typeof input.sessionCookie === "string" && input.sessionCookie.length > 0
            ? persistence.identity.hasher.hash(parseRawBrowserCredential(input.sessionCookie))
            : null;
      } catch {
        previous = null;
      }
      const issued = await options
        .issueSession(choice, async (tx, session) => {
          if (
            session.actor.actorReference !== choice ||
            session.policy.code !== "WorkforceStandard"
          )
            fail("Denied");
          await recordStaffPinSession(
            tx,
            {
              brandReference: device.brandReference,
              storeReference: device.storeReference,
              sessionReference: session.sessionReference,
              attemptReference: result.attemptReference,
              deviceReference: device.deviceReference,
              actorReference: choice,
              issuedAt: session.createdAt,
              replacedSessionSelectorHash:
                typeof previous === "string" && /^[0-9a-f]{64}$/u.test(previous) ? previous : null,
              auditReference: reference(),
            },
            policy,
          );
        })
        .catch(() => fail("Unavailable"));
      return Object.freeze({ status: "SignedIn" as const, sessionCookie: issued.sessionCookie });
    },

    /**
     * Inside the transaction creating a full sign-in: when this browser is a registered tablet,
     * ends the PIN sessions started on it (the previous person is signed out at once).
     */
    endTabletPinSessions,

    /** After a full sign-in that could not run inside its session's transaction (OIDC callback). */
    async afterFullSignIn(input: {
      readonly deviceCookie: unknown;
      readonly session: SignedInSession;
    }): Promise<{ readonly signedOut: number }> {
      if (deviceHash(input.deviceCookie) === null) return { signedOut: 0 };
      return run((tx) => endTabletPinSessions(tx, input.deviceCookie, input.session));
    },

    /** The signed-in staff member's own PIN and how this session was started. */
    async ownPin(input: { readonly sessionCookie: unknown }) {
      return run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, "merchant.access");
        if (!(await scope.allowed())) return fail("Denied");
        const at = now();
        const actor = String(scope.actorReference);
        const states = await readStaffPinStates(tx, {
          ...where(scope),
          at,
          actorReferences: [actor],
        });
        const session = await readStaffPinSession(tx, {
          sessionReference: String(scope.sessionReference),
          at,
        });
        return Object.freeze({
          pin: states.get(actor) ?? notSet,
          signIn: session.pinIssued ? ("Pin" as const) : ("Account" as const),
          verifiedUntil: session.verifiedUntil,
        });
      });
    },

    /** The staff member sets or changes their own PIN (full sign-in or verified PIN session). */
    async setOwnPin(input: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
      readonly pin: unknown;
      readonly confirmation: unknown;
    }): Promise<StaffPinView | { readonly problem: StaffPinProblem }> {
      const session = await authorize(input);
      return run(async (tx) => {
        const scope = await scopeFor(
          tx,
          input.sessionCookie,
          "merchant.access",
          session.sessionReference,
        );
        if (!(await scope.allowed())) return fail("Denied");
        const at = now();
        await requireFullSignIn(tx, session.sessionReference, at);
        const result = await setStaffPin(
          tx,
          {
            ...where(scope),
            actorReference: String(scope.actorReference),
            sessionReference: session.sessionReference,
            pin: input.pin,
            confirmation: input.confirmation,
            at,
            auditReference: reference(),
          },
          options.kdf,
          policy,
        );
        if (result.status === "Invalid") return Object.freeze({ problem: result.problem });
        return Object.freeze({
          state: "Set" as const,
          changedAt: result.changedAt,
          lockedUntil: null,
        });
      });
    },

    /** Registered tablets and staff PINs of the selected Store, each for whoever may manage it. */
    async overview(input: { readonly sessionCookie: unknown; readonly deviceCookie: unknown }) {
      return run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, "merchant.access");
        if (!(await scope.allowed())) return fail("Denied");
        const manageDevices = await may(scope, "identity.store_device.manage");
        const resetPins = await may(scope, "identity.staff_pin.reset");
        if (!manageDevices && !resetPins) return fail("Denied");
        const store = where(scope);
        const at = now();
        const viewer = String(scope.actorReference);
        const members = await activeMembers(tx, store);
        const current = await tablet(tx, input.deviceCookie);
        const thisDevice =
          current !== null &&
          current.brandReference === store.brandReference &&
          current.storeReference === store.storeReference
            ? Object.freeze({ device: current.deviceReference, label: current.label })
            : null;
        let devices = null;
        if (manageDevices) {
          const listed = await listStoreSignInDevices(tx, store);
          const label = await labelsFor(tx, store, {
            viewer,
            at,
            members,
            others: listed.map((item) => item.registeredByActorReference),
          });
          devices = listed.map((item) =>
            Object.freeze({
              device: item.deviceReference,
              label: item.label,
              registeredAt: item.registeredAt,
              registeredBy: label(item.registeredByActorReference),
              lastUsedAt: item.lastUsedAt,
            }),
          );
        }
        let staffPins = null;
        if (resetPins) {
          const states =
            members.length === 0
              ? new Map()
              : await readStaffPinStates(tx, {
                  ...store,
                  at,
                  actorReferences: members.map((member) => member.actorReference),
                });
          const label = await labelsFor(tx, store, { viewer, at, members });
          const labels = distinctStaffLabels(
            members.map((member) => ({
              actorReference: member.actorReference,
              label: label(member.actorReference),
            })),
          );
          staffPins = members
            .map((member) => {
              const pin: StaffPinView = states.get(member.actorReference) ?? notSet;
              return Object.freeze({
                staff: member.actorReference,
                name: labels.get(member.actorReference) ?? "Staff member",
                state: pin.state,
                changedAt: pin.changedAt,
                lockedUntil: pin.lockedUntil,
              });
            })
            .sort((a, b) => a.name.localeCompare(b.name, "en"));
        }
        return Object.freeze({ thisDevice, devices, staffPins });
      });
    },

    /** Registers the tablet this manager is using; returns the new tablet secret for its cookie. */
    async registerDevice(input: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
      readonly deviceCookie: unknown;
      readonly label: unknown;
    }) {
      const session = await authorize(input);
      return run(async (tx) => {
        const scope = await scopeFor(
          tx,
          input.sessionCookie,
          "identity.store_device.manage",
          session.sessionReference,
        );
        if (!(await scope.allowed())) return fail("Denied");
        const at = now();
        await requireFullSignIn(tx, session.sessionReference, at);
        const store = where(scope);
        const current = await tablet(tx, input.deviceCookie);
        if (
          current !== null &&
          current.brandReference === store.brandReference &&
          current.storeReference === store.storeReference
        )
          return fail("AlreadyRegistered");
        const secret = generateStoreDeviceSecret();
        const registered = await registerStoreSignInDevice(
          tx,
          {
            ...store,
            deviceReference: reference(),
            selectorHash: options.deviceHasher.hash(secret),
            label: input.label,
            actorReference: String(scope.actorReference),
            sessionReference: session.sessionReference,
            at,
            auditReference: reference(),
          },
          policy,
        );
        if (registered === "LabelInvalid")
          return Object.freeze({ status: "LabelInvalid" as const });
        const label = await labelsFor(tx, store, {
          viewer: String(scope.actorReference),
          at,
          members: [],
          others: [registered.registeredByActorReference],
        });
        return Object.freeze({
          status: "Registered" as const,
          deviceCookie: secret,
          device: Object.freeze({
            device: registered.deviceReference,
            label: registered.label,
            registeredAt: registered.registeredAt,
            registeredBy: label(registered.registeredByActorReference),
            lastUsedAt: null,
          }),
        });
      });
    },

    /** Removes a registered tablet of the selected Store and signs out its PIN sessions. */
    async revokeDevice(input: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
      readonly deviceCookie: unknown;
      readonly device: unknown;
    }) {
      if (typeof input.device !== "string" || !uuid.test(input.device)) return fail("Denied");
      const device = input.device;
      const session = await authorize(input);
      return run(async (tx) => {
        const scope = await scopeFor(
          tx,
          input.sessionCookie,
          "identity.store_device.manage",
          session.sessionReference,
        );
        if (!(await scope.allowed())) return fail("Denied");
        const at = now();
        await requireFullSignIn(tx, session.sessionReference, at);
        const store = where(scope);
        const current = await tablet(tx, input.deviceCookie);
        const revoked = await revokeStoreSignInDevice(
          tx,
          {
            ...store,
            deviceReference: device,
            actorReference: String(scope.actorReference),
            sessionReference: session.sessionReference,
            at,
            auditReference: reference(),
          },
          policy,
        );
        if (revoked === null) return fail("NotFound");
        return Object.freeze({
          signedOut: revoked.signedOut,
          thisDevice: current !== null && current.deviceReference === device,
        });
      });
    },

    /** A manager resets a staff member's PIN at the selected Store. */
    async resetPin(input: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
      readonly staff: unknown;
    }): Promise<StaffPinView> {
      if (typeof input.staff !== "string" || !uuid.test(input.staff)) return fail("Denied");
      const staff = input.staff;
      const session = await authorize(input);
      return run(async (tx) => {
        const scope = await scopeFor(
          tx,
          input.sessionCookie,
          "identity.staff_pin.reset",
          session.sessionReference,
        );
        if (!(await scope.allowed())) return fail("Denied");
        const at = now();
        await requireFullSignIn(tx, session.sessionReference, at);
        const store = where(scope);
        if (
          !(await listStoreMembers(directory(tx), store)).some(
            (member) => member.actorReference === staff,
          )
        )
          return fail("NotFound");
        const result = await resetStaffPin(
          tx,
          {
            ...store,
            staffReference: staff,
            actorReference: String(scope.actorReference),
            sessionReference: session.sessionReference,
            at,
            auditReference: reference(),
          },
          policy,
        );
        if (result.status === "NotSet") return fail("NotSet");
        return Object.freeze({
          state: "Reset" as const,
          changedAt: result.changedAt,
          lockedUntil: null,
        });
      });
    },

    /**
     * The BFF gate: true when this request's session was started with a PIN and has no step-up in
     * the last 15 minutes, so a sensitive action must be refused. A session that cannot be read
     * is left to the route's own authorization.
     */
    async requiresFullSignIn(input: { readonly sessionCookie: unknown; readonly csrf: unknown }) {
      let session: AuthenticationSession;
      try {
        session = await options.authentication.authorize({
          sessionCookie: input.sessionCookie,
          csrf: input.csrf,
        });
      } catch {
        return false;
      }
      return run(async (tx) => {
        const pin = await readStaffPinSession(tx, {
          sessionReference: session.sessionReference,
          at: now(),
        });
        return pin.pinIssued && pin.verifiedUntil === null;
      });
    },
  });
}
