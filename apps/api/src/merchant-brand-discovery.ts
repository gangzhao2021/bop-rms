import {
  BrowserSessionError,
  WorkforceBrowserSessionService,
  createPostgresWorkforceBrowserSessionStore,
  createPostgresCurrentWorkforceBrowserSessionSource,
  createPostgresBrowserBrandSessionSelectionStore,
  readClosedRecord,
  type AuthenticationSession,
} from "@bop/identity";
import {
  BrandConfigurationOperationError,
  parseBrandReference,
  parseCanonicalInstant,
  type Brand,
} from "@bop/tenant";
import {
  createPostgresMembershipBrandDiscoverySource,
  parseMembershipBrandDiscoveryPage,
} from "@bop/membership";
import { createPostgresCurrentBrandAdministrationPermissionPolicySource } from "@bop/permission";
import {
  createMerchantCurrentBrandAdministrationCapability,
  merchantBrandAdministrationCapabilityRequiredFields,
} from "./merchant-brand-administration-capability.js";
import { readMerchantCurrentBrandAdministrationAuthority } from "./merchant-current-brand-scope.js";
import type { PersistentBrandAdministrationBffOptions } from "./persistent-brand-administration-bff.js";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
export type MerchantBrandDiscoveryPersistence = Omit<
  PersistentBrandAdministrationBffOptions,
  "brandReference"
>;
export interface MerchantBrandDiscoveryOptions {
  readonly source: MerchantBrandDiscoveryPersistence;
  readonly transactions: Host["transactions"];
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
}
export class MerchantBrandDiscoveryError extends BrandConfigurationOperationError {
  constructor(readonly reason: "Invalid" | "Denied" | "SelectionConflict" | "Unavailable") {
    super(
      reason === "Invalid"
        ? "BRAND_CONFIGURATION_INPUT_INVALID"
        : reason === "Denied"
          ? "BRAND_CONFIGURATION_PERMISSION_DENIED"
          : reason === "SelectionConflict"
            ? "BRAND_CONFIGURATION_VERSION_CONFLICT"
            : "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    );
    this.name = "MerchantBrandDiscoveryError";
  }
}
const fail = (reason: MerchantBrandDiscoveryError["reason"] = "Unavailable"): never => {
  throw new MerchantBrandDiscoveryError(reason);
};
const path = "/app/organization/brands";
const reference = (value: unknown) => String(parseBrandReference(value));
const optionalReference = (value: unknown) => (value === null ? null : reference(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export interface MerchantBrandDiscoveryItem {
  readonly brandReference: string;
  readonly code: string;
  readonly displayName: string;
  readonly lifecycle: Brand["lifecycle"];
  readonly defaultLocale: string;
  readonly version: number;
}
export interface MerchantBrandDiscoveryPage {
  readonly profile: "MerchantBrandDiscoveryV1";
  readonly actorReference: string;
  readonly afterBrandReference: string | null;
  readonly items: readonly MerchantBrandDiscoveryItem[];
  readonly hasMore: boolean;
  readonly nextAfterBrandReference: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
interface Credentials {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
}
export interface MerchantBrandDiscoveryListInput extends Credentials {
  readonly afterBrandReference: string | null;
}
export interface MerchantBrandDiscoverySelectInput extends Credentials {
  readonly brandReference: string;
  readonly expectedSelectedBrandReference: string | null;
}
export interface MerchantBrandSelectionReceipt {
  readonly actorReference: string;
  readonly brandReference: string;
  readonly href: string;
}

/** Only owning Membership supplies discovery IDs. Identity establishes the real
 * session in this same physical transaction; neither this packet nor selection
 * grants business access. Every returned/omitted candidate stays held to COMMIT. */
export function createMerchantBrandDiscovery(options: MerchantBrandDiscoveryOptions) {
  const source = options.source,
    identity = source.identity,
    configuration = identity.configuration,
    configurationIdentity = JSON.stringify(configuration),
    currentActor = source.currentActor,
    clock = source.now,
    transactions = options.transactions,
    run = transactions.run,
    register = options.registerBeforeCommit,
    identityPorts = [
      identity.hasher,
      identity.envelopes,
      identity.provider,
      identity.credentials,
      identity.pkce,
    ];
  const bounded = (error: unknown): never => {
    if (error instanceof MerchantBrandDiscoveryError) throw error;
    if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED")
      return fail("Denied");
    return fail();
  };
  async function transaction<T>(
    cookie: unknown,
    csrf: unknown,
    sensitive: boolean,
    work: (h: {
      tx: Parameters<Host["registerBeforeCommit"]>[0];
      observedAt: string;
      check(): string;
      deadline(): string;
      retain(value: string): void;
      session(): Promise<AuthenticationSession>;
      bootstrap: Awaited<ReturnType<WorkforceBrowserSessionService["bootstrap"]>>;
      selected(): Promise<string | null>;
      pinSelection(value: string | null): void;
      verifyCandidate(brand: string, screen: "List" | "Detail"): Promise<Brand | null>;
      finalizers: (() => unknown)[];
    }) => Promise<T>,
  ): Promise<T> {
    let sealed = false,
      failed = false;
    const finalizers: (() => unknown)[] = [];
    try {
      if (options.transactions !== transactions || transactions.run !== run) return fail();
      const result = await transactions.run(async (tx) => {
        try {
          const query = tx.query,
            observedAt = String(parseCanonicalInstant(clock.call(source)));
          let latest = observedAt,
            deadline = new Date(Date.parse(observedAt) + 5000).toISOString(),
            ready = false,
            busy = false,
            selectionPinned = false,
            expectedSelection: string | null = null;
          const check = () => {
            const at = String(parseCanonicalInstant(clock.call(source)));
            if (
              failed ||
              tx.query !== query ||
              options.source !== source ||
              source.identity !== identity ||
              identity.configuration !== configuration ||
              JSON.stringify(configuration) !== configurationIdentity ||
              [
                identity.hasher,
                identity.envelopes,
                identity.provider,
                identity.credentials,
                identity.pkce,
              ].some((port, index) => port !== identityPorts[index]) ||
              source.currentActor !== currentActor ||
              source.now !== clock ||
              options.transactions !== transactions ||
              transactions.run !== run ||
              options.registerBeforeCommit !== register ||
              at < latest ||
              at >= deadline
            ) {
              failed = true;
              return fail();
            }
            latest = at;
            return at;
          };
          const retain = (value: string) => {
            const until = String(parseCanonicalInstant(value));
            if (until < deadline) deadline = until;
            check();
          };
          await register(
            tx,
            async () => {
              try {
                check();
                if (!ready || busy) return fail();
                await reread();
                check();
              } catch (error) {
                failed = true;
                return bounded(error);
              }
            },
            () => {
              check();
              if (!ready || busy) return fail();
              sealed = true;
            },
          );
          check();
          const store = createPostgresWorkforceBrowserSessionStore({
            transactions: { run: (work) => work(tx) },
            now: check,
            currentActor: (...args) => currentActor.call(source, ...args),
            environment: configuration.environment,
            issuer: configuration.issuer,
            clientId: configuration.clientId,
            envelopes: identity.envelopes,
            hasher: identity.hasher,
            redirectUri: configuration.redirectUri,
            allowedPostLoginPaths: configuration.allowedPostLoginPaths,
          });
          const service = new WorkforceBrowserSessionService({ ...identity, now: check, store });
          const bootstrap = await service.bootstrap(cookie);
          retain(bootstrap.validUntil);
          const initial = JSON.stringify({
            session: bootstrap.session,
            mfa: bootstrap.recentMfa,
            csrf: bootstrap.csrf,
          });
          if (sensitive) {
            const authorized = await service.authorize({ sessionCookie: cookie, csrf });
            if (
              !same(authorized.session, bootstrap.session) ||
              !same(authorized.recentMfa, bootstrap.recentMfa)
            )
              return fail("Denied");
            retain(authorized.validUntil);
          }
          const strong = createPostgresCurrentWorkforceBrowserSessionSource({
            hasher: identity.hasher,
            envelopes: identity.envelopes,
            configuration: {
              environment: configuration.environment,
              issuer: configuration.issuer,
              clientId: configuration.clientId,
            },
            now: check,
            currentActor: (...args) => currentActor.call(source, ...args),
          });
          const currentSession = async () => {
            check();
            const actual = await strong(tx, cookie);
            check();
            if (
              actual.sessionReference !== bootstrap.session.sessionReference ||
              actual.actor.actorReference !== bootstrap.session.actor.actorReference ||
              actual.authenticatedAt !== bootstrap.session.authenticatedAt
            )
              return fail("Denied");
            retain(actual.idleExpiresAt);
            retain(actual.absoluteExpiresAt);
            retain(bootstrap.recentMfa.validUntil);
            return actual;
          };
          const selection = createPostgresBrowserBrandSessionSelectionStore();
          const selected = async () => {
            check();
            const value = await selection.read(tx, bootstrap.session, check());
            check();
            return value?.brandReference ?? null;
          };
          const candidates = new Map<
            string,
            {
              brand: Brand;
              decision: unknown;
              read: () => Promise<
                Awaited<ReturnType<typeof readMerchantCurrentBrandAdministrationAuthority>>
              >;
            }
          >();
          const verifyCandidate = async (brandReference: string, screen: "List" | "Detail") => {
            const scope = Object.freeze({
              tenantReference: brandReference,
              brandReference,
              actorReference: String(bootstrap.session.actor.actorReference),
            });
            let held = candidates.get(brandReference);
            if (!held) {
              const policy = createPostgresCurrentBrandAdministrationPermissionPolicySource(tx);
              const read = async () => {
                const packet = await readMerchantCurrentBrandAdministrationAuthority(
                  tx,
                  await currentSession(),
                  brandReference,
                  check(),
                  ["organization.manage"],
                  policy,
                );
                if (
                  packet.validUntil === null ||
                  String(packet.context.brand.brandReference) !== brandReference ||
                  String(packet.context.actor.actorReference) !== scope.actorReference ||
                  packet.context.store !== null
                )
                  return fail();
                retain(packet.validUntil);
                return packet;
              };
              const actual = await read(),
                decision = actual.decisions[0];
              if (
                !decision ||
                decision.action !== "organization.manage" ||
                decision.scopeKind !== "Brand"
              )
                return fail();
              held = { brand: actual.context.brand, decision, read };
              candidates.set(brandReference, held);
            }
            const expected = held;
            const authority = async () => {
              const packet = await expected.read();
              if (
                !same(packet.context.brand, expected.brand) ||
                !same(packet.decisions[0], expected.decision)
              )
                return fail();
              return packet;
            };
            const current = await authority(),
              permission = current.decisions[0];
            if (permission?.effect === "Deny") return null;
            if (permission?.effect !== "Allow") return fail();
            const capabilityDeadline = deadline;
            const capability = createMerchantCurrentBrandAdministrationCapability({
              mode: "Navigation",
              screen,
              transaction: tx,
              scope,
              clock: { now: check },
              originalObservedAt: observedAt,
              originalValidUntil: capabilityDeadline,
              registerBeforeCommit: register,
              async holdCurrentBrandAdministrationAuthority(actualTx, input) {
                check();
                if (
                  actualTx !== tx ||
                  !same(input.scope, scope) ||
                  input.permission !== "organization.manage" ||
                  input.purposeCode !== "BRAND_ADMINISTRATION" ||
                  input.observedAt < observedAt ||
                  input.observedAt > check() ||
                  input.validUntil > capabilityDeadline ||
                  !same(input.requiredFields, merchantBrandAdministrationCapabilityRequiredFields)
                )
                  return fail();
                const actual = await authority(),
                  decision = actual.decisions[0];
                if (decision?.effect !== "Allow" || actual.validUntil === null)
                  return fail("Denied");
                return {
                  scope,
                  administrationContext: actual.context,
                  permission: decision,
                  validUntil: actual.validUntil,
                };
              },
            });
            const visible = await capability.holdForNavigation();
            retain(capability.leaseDeadline());
            finalizers.push(() => capability.assertFinalized());
            return visible ? expected.brand : null;
          };
          const reread = async () => {
            const actual = await service.bootstrap(cookie);
            if (
              JSON.stringify({
                session: actual.session,
                mfa: actual.recentMfa,
                csrf: actual.csrf,
              }) !== initial
            )
              return fail("Denied");
            retain(actual.validUntil);
            if (sensitive) {
              const authorized = await service.authorize({ sessionCookie: cookie, csrf });
              retain(authorized.validUntil);
              await currentSession();
            }
            if (selectionPinned && (await selected()) !== expectedSelection)
              return fail("SelectionConflict");
            for (const held of candidates.values()) {
              const current = await held.read();
              if (
                !same(current.context.brand, held.brand) ||
                !same(current.decisions[0], held.decision)
              )
                return fail();
            }
          };
          busy = true;
          try {
            const result = await work({
              tx,
              observedAt,
              check,
              deadline: () => deadline,
              retain,
              session: currentSession,
              bootstrap,
              selected,
              pinSelection(value) {
                expectedSelection = value;
                selectionPinned = true;
              },
              verifyCandidate,
              finalizers,
            });
            check();
            ready = true;
            return result;
          } finally {
            busy = false;
          }
        } catch (error) {
          failed = true;
          return bounded(error);
        }
      });
      if (!sealed || failed) return fail();
      for (const finalize of finalizers) finalize();
      return result;
    } catch (error) {
      failed = true;
      if (error instanceof MerchantBrandDiscoveryError) throw error;
      if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED")
        return fail("Denied");
      return fail();
    }
  }
  const bootstrap = (cookie: unknown) =>
    transaction(cookie, undefined, false, async (h) => {
      const selectedBrandReference = await h.selected();
      h.pinSelection(selectedBrandReference);
      return Object.freeze({ ...h.bootstrap, selectedBrandReference });
    });
  return Object.freeze({
    bootstrap,
    async discoveryBootstrap(cookie: unknown) {
      const current = await bootstrap(cookie);
      return Object.freeze({
        authenticated: true as const,
        csrf: current.csrf,
        recentMfaRequired: current.recentMfaRequired,
        actorReference: String(current.session.actor.actorReference),
        selectedBrandReference: current.selectedBrandReference,
      });
    },
    async list(raw: MerchantBrandDiscoveryListInput): Promise<MerchantBrandDiscoveryPage> {
      let input: Record<string, unknown>, after: string | null;
      try {
        input = readClosedRecord(raw, ["sessionCookie", "csrf", "afterBrandReference"]);
        after = optionalReference(input.afterBrandReference);
      } catch {
        return fail("Invalid");
      }
      return transaction(input.sessionCookie, input.csrf, true, async (h) => {
        const session = await h.session(),
          actorReference = String(session.actor.actorReference);
        const membershipDeadline = h.deadline();
        const memberships = createPostgresMembershipBrandDiscoverySource({
          transaction: h.tx,
          actorReference,
          clock: { now: h.check },
          originalObservedAt: h.observedAt,
          originalValidUntil: h.deadline(),
          registerBeforeCommit(actual, guard, final) {
            if (actual !== h.tx) return fail();
            return register(h.tx, guard, final);
          },
          authority: {
            async holdUntilTransactionCompletes(tx, request) {
              if (
                tx !== h.tx ||
                request.actorReference !== actorReference ||
                request.purposeCode !== "BRAND_DISCOVERY" ||
                request.observedAt < h.observedAt ||
                request.observedAt > h.check() ||
                request.validUntil > membershipDeadline
              )
                return fail();
              return { session: await h.session(), validUntil: h.deadline() };
            },
          },
        });
        const page = parseMembershipBrandDiscoveryPage(
          await memberships.holdPage({ afterBrandReference: after, limit: 20 }),
        );
        if (
          page.actorReference !== actorReference ||
          page.afterBrandReference !== after ||
          page.limit !== 20 ||
          page.observedAt < h.observedAt ||
          page.observedAt > h.check() ||
          page.validUntil > membershipDeadline
        )
          return fail();
        h.retain(page.validUntil);
        h.finalizers.push(() => memberships.assertFinalized());
        const items: MerchantBrandDiscoveryItem[] = [];
        for (const brand of page.brandReferences) {
          const current = await h.verifyCandidate(brand, "List");
          if (current)
            items.push(
              Object.freeze({
                brandReference: String(current.brandReference),
                code: current.code,
                displayName: current.displayName,
                lifecycle: current.lifecycle,
                defaultLocale: current.defaultLocale,
                version: current.version,
              }),
            );
        }
        return Object.freeze({
          profile: "MerchantBrandDiscoveryV1" as const,
          actorReference,
          afterBrandReference: after,
          items: Object.freeze(items),
          hasMore: page.hasMore,
          nextAfterBrandReference: page.nextAfterBrandReference,
          observedAt: h.observedAt,
          validUntil: h.deadline(),
        });
      });
    },
    async select(raw: MerchantBrandDiscoverySelectInput): Promise<MerchantBrandSelectionReceipt> {
      let input: Record<string, unknown>, brand: string, expected: string | null;
      try {
        input = readClosedRecord(raw, [
          "sessionCookie",
          "csrf",
          "brandReference",
          "expectedSelectedBrandReference",
        ]);
        brand = reference(input.brandReference);
        expected = optionalReference(input.expectedSelectedBrandReference);
      } catch {
        return fail("Invalid");
      }
      const result = await transaction(input.sessionCookie, input.csrf, true, async (h) => {
        const before = await h.selected();
        // An immutable same-target retry is safe even when the first reply was lost.
        if (before !== brand && (before !== expected || before !== null)) {
          // Report a business conflict only after the actual authenticated read
          // and its pinned selection complete all owning COMMIT guards. The
          // Identity transaction boundary intentionally sanitizes thrown errors.
          h.pinSelection(before);
          return null;
        }
        if (
          !(await h.verifyCandidate(brand, "List")) ||
          !(await h.verifyCandidate(brand, "Detail"))
        )
          return fail("Denied");
        const session = await h.session(),
          selection = createPostgresBrowserBrandSessionSelectionStore();
        const saved = await selection.write(h.tx, session, { brandReference: brand }, h.check());
        if (saved.brandReference !== brand) return fail();
        h.pinSelection(brand);
        return Object.freeze({
          actorReference: String(session.actor.actorReference),
          brandReference: brand,
          href: `${path}/${brand}`,
        });
      });
      if (result === null) return fail("SelectionConflict");
      return result;
    },
  });
}
