import { URL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { createCustomerMenuQueryService } from "../../rms/catalog/src/index.ts";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
} from "../../bop/identity/src/index.ts";
import {
  createPostgresCustomerCartStore,
  createPostgresCartPresentationStore,
  createPostgresCartItemStore,
} from "../../rms/ordering/src/index.ts";
import { createCustomerCartComposition } from "../../../apps/api/src/customer-cart-composition.ts";
import { CustomerCartHandler } from "../../../apps/api/src/customer-cart.ts";
import { createApiServerRuntime, createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client, Pool } = pg;
import {
  fixture,
  id,
  now as at,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createCustomerEntryComposition } from "../../../apps/api/src/customer-entry-composition.ts";
import { CustomerEntryHandler } from "../../../apps/api/src/customer-entry.ts";
import { CustomerMenuHandler } from "../../../apps/api/src/customer-menu.ts";
import { withCustomerEntryBrowser } from "../test-support/customer-entry-browser.mjs";
function check(value, code) {
  if (!value) throw new Error(`WP2222_${code}`);
}
it("runs the normal Pickup Entry, Menu and Cart browser journey with persisted commands", async () => {
  await withIsolatedDatabase({ workPackage: "WP-2222" }, async (database) => {
    const admin = new Client(database.clientConfig);
    const pools = [];
    const role = `bop_wp2222_${database.runId}`;
    const logs = [];
    let runtime;
    let roleCreated = false;
    let phase = "SETUP";
    let sequence = 100;
    const observedAt = at;
    const bindingCurrent = true;
    const displayAvailable = true;
    const selectionRejected = false;
    const catalogState = "Current";
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roleCreated = true;
      await admin.query(
        `GRANT USAGE ON SCHEMA bop_identity, rms_ordering, platform_helpers, platform_audit TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON bop_identity.guest_session, bop_identity.guest_session_operation TO ${role}`,
      );
      await admin.query(`GRANT SELECT, INSERT, UPDATE ON rms_ordering.cart TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON rms_ordering.cart_line TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON rms_ordering.cart_customer_owner, rms_ordering.cart_creation_operation, platform_audit.audit_record TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON platform_audit.audit_chain_head TO ${role}`,
      );
      await admin.query(`GRANT SELECT, INSERT ON rms_ordering.cart_operation_record TO ${role}`);
      await admin.query(`GRANT SELECT ON rms_ordering.cart_quote_attachment TO ${role}`);
      function runner() {
        const pool = new Pool({
          ...database.clientConfig,
          max: 2,
          application_name: "bop_wp2222_acceptance",
          connectionTimeoutMillis: 5000,
          query_timeout: 5000,
        });
        pools.push(pool);
        const base = createTenantTransactionRunner(
          {
            options: pool.options,
            async connect() {
              const client = await pool.connect();
              try {
                await client.query(`SET ROLE ${role}`);
                return client;
              } catch {
                client.release(true);
                throw new Error("WP2222_ROLE_FAILED");
              }
            },
          },
          { brandId: id(1), storeId: id(2) },
        );
        return base;
      }

      const key = randomBytes(32);
      const credentials = createGuestSessionCredentialProvider(key);
      key.fill(0);
      const scope = { brandReference: id(1), storeReference: id(2) };
      const f = fixture();
      Object.assign(f.payload, { channel: "Pickup", publicTableReference: null });
      Object.assign(f.context, {
        channel: "Pickup",
        publicTableReference: null,
        tableReference: null,
        tableLifecycle: null,
        assignmentState: null,
      });
      const sessionOptions = {
        ...f.options.session,
        credentials,
        store: createPostgresGuestSessionEntryStore(runner(), scope),
      };
      const entry = createCustomerEntryComposition({ ...f.options, session: sessionOptions });
      const sessionService = () =>
        new GuestSessionService({
          ...sessionOptions,
          binding: { validate: async () => (bindingCurrent ? "Current" : "Unavailable") },
          now: () => observedAt,
        });
      function projection() {
        return {
          projectionName: "catalog_published_menu_v1",
          projectionVersion: 1,
          generationReference: id(530),
          sourceEventReference: id(531),
          sourceAggregateVersion: 1,
          sourceCheckpoint: id(531),
          lastRebuiltAt: at,
          freshnessStatus: "Fresh",
          snapshot: {
            brandReference: scope.brandReference,
            menuReference: id(518),
            menuVersionReference: id(519),
            releaseReference: id(532),
            snapshotDigest: `sha256:${"b".repeat(64)}`,
            defaultLocale: "en-CA",
            localizedNames: { "en-CA": "Synthetic menu" },
            storeReferences: [scope.storeReference],
            channelCodes: ["PICKUP"],
            orderTypeCodes: ["PICKUP"],
            timeZone: "America/Toronto",
            effectiveFrom: "2026-01-15T11:00:00.000Z",
            effectiveUntil: null,
            sections: [
              {
                sectionReference: id(533),
                internalCode: "SYNTHETIC",
                localizedNames: { "en-CA": "Synthetic section" },
                sortOrder: 1,
                sellables: [
                  {
                    placementReference: id(534),
                    sellableReference: id(507),
                    productVersionReference: id(520),
                    localizedNames: { "en-CA": "Synthetic drink" },
                    presentationRole: "Standard",
                    sortOrder: 1,
                    pinned: false,
                    configuredAvailability: "Available",
                    allergenDisclosure: {
                      registryVersionReference: id(535),
                      items: [],
                      allergenFreeClaim: false,
                      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                    },
                    optionRules: [
                      {
                        bindingReference: id(521),
                        optionSetVersionReference: id(522),
                        minimumSelections: 0,
                        maximumSelections: 1,
                        enabledOptionReferences: [id(508)],
                        defaultOptionReferences: [],
                        options: [
                          {
                            optionReference: id(508),
                            localizedNames: { "en-CA": "Synthetic option" },
                            maximumQuantity: 2,
                            conflictOptionReferences: [],
                            selectedByDefault: false,
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      const catalog = createCustomerMenuQueryService({
        stores: {
          async resolvePublic(reference) {
            return reference === id(4) ? { ...scope, status: "Active" } : null;
          },
        },
        projections: {
          async loadCandidates() {
            if (catalogState === "Missing") return [];
            const source = projection();
            if (catalogState === "Stale") source.lastRebuiltAt = "2026-08-02T13:59:00.000Z";
            if (catalogState === "Changed") source.snapshot.menuVersionReference = id(999);
            return [source];
          },
        },
      });
      // Fresh Identity pool, real credential verifier, and per-request Ordering pools.
      const composition = createCustomerCartComposition({
        items: (session) => itemPorts(session),
        presentation: () => ({
          catalog,
          quotes: createPostgresCartPresentationStore({ ...scope, runner: runner() }),
        }),
        session: sessionService(),
        ordering(session) {
          check(
            session.brandReference === scope.brandReference &&
              session.storeReference === scope.storeReference,
            "SCOPE_DRIFT",
          );
          return {
            repository: createPostgresCustomerCartStore({ ...scope, runner: runner() }),
            references: {
              generate: () => id(sequence++),
              hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
            },
            policy: {
              async resolve() {
                return {
                  policyVersionReference: id(6),
                  policyDigest: `sha256:${"a".repeat(64)}`,
                  idleTimeoutSeconds: 3600,
                  absoluteTimeoutSeconds: 86400,
                  sourceChannel: "Qr",
                };
              },
            },
            audit: {
              async prepare(input) {
                return {
                  auditId: id(sequence++),
                  brandId: scope.brandReference,
                  storeId: scope.storeReference,
                  actor: { type: "System" },
                  actionCode: "ORDERING_CART_CREATE",
                  targetType: "OrderingCart",
                  targetId: input.cartReference,
                  reasonCode: "AUTHORIZED_CART_MUTATION",
                  correlationId: input.operationReference,
                  occurredAt: input.occurredAt,
                  sourceChannel: "CUSTOMER_PWA",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                };
              },
            },
          };
        },
        display: {
          async resolve(request) {
            return displayAvailable
              ? {
                  ...request,
                  brandName: "Synthetic Brand",
                  storeName: "Synthetic Store",
                  serviceMode: request.orderType,
                }
              : null;
          },
        },
      });
      function itemPorts(session) {
        return {
          repository: createPostgresCartItemStore({
            ...scope,
            runner: runner(),
            requireUnquotedPresentation: true,
          }),
          references: {
            generate: () => id(sequence++),
            hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
            equals: (left, right) => left === right,
          },
          authorization: {
            async authorize(input) {
              return {
                guestSession: session,
                audit: {
                  auditId: id(sequence++),
                  brandId: scope.brandReference,
                  storeId: scope.storeReference,
                  actor: { type: "System" },
                  actionCode: `ORDERING_CART_ITEM_${input.action.toUpperCase()}`,
                  targetType: "OrderingCart",
                  targetId: input.cartReference,
                  reasonCode: "AUTHORIZED_CART_MUTATION",
                  correlationId: input.operationReference,
                  occurredAt: input.observedAt,
                  sourceChannel: "CUSTOMER_PWA",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                },
              };
            },
          },
          // Selection evidence is an explicit synthetic public-source fixture. The read uses the real Catalog query service.
          catalog: {
            async validateSelection(input) {
              if (selectionRejected) return { status: "Rejected", reason: "SELLABLE_UNAVAILABLE" };
              return {
                status: "Accepted",
                ...input,
                menuVersionReference: id(519),
                productVersionReference: id(520),
                catalogChannelCode: "PICKUP",
                catalogOrderTypeCode: "PICKUP",
                ruleEvidence: [{ bindingReference: id(521), optionSetVersionReference: id(522) }],
                validatedAt: input.observedAt,
              };
            },
          },
        };
      }
      await withCustomerEntryBrowser(
        (origin) => {
          runtime = createApiServerRuntime({
            port: 0,
            host: "127.0.0.1",
            logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
            customerEntry: new CustomerEntryHandler({
              port: entry,
              allowedOrigin: origin,
              now: () => at,
              uuidV7Factory: () => id(sequence++),
            }),
            customerMenu: new CustomerMenuHandler({ port: catalog, now: () => observedAt }),
            customerCart: new CustomerCartHandler({
              port: composition,
              allowedOrigin: origin,
              now: () => observedAt,
            }),
          });
          return runtime;
        },
        async ({ origin, newContext, violations }) => {
          const cartReferences = new Set();
          for (const viewport of [
            { width: 390, height: 844 },
            { width: 1280, height: 900 },
          ]) {
            phase = "ENTRY";
            const context = await newContext(viewport);
            const page = await context.newPage();
            const token = f.token();
            const [entryResponse] = await Promise.all([
              page.waitForResponse(
                (response) => new URL(response.url()).pathname === "/bff/customer/entry",
              ),
              page.goto(`${origin}/#qr=${token}`),
            ]);
            check(entryResponse.status() === 201, "ENTRY_STATUS");
            const entryBody = await entryResponse.json();
            const cookie = (await context.cookies())[0];
            check(
              cookie?.secure && cookie.httpOnly && cookie.name === "__Host-bop-guest",
              "COOKIE",
            );
            await page.getByRole("button", { name: "Continue to menu" }).click();
            phase = "MENU";
            await page.getByRole("link", { name: "View Synthetic drink", exact: true }).click();
            await page.getByRole("button", { name: "Configure and add" }).click();
            const [added] = await Promise.all([
              page.waitForResponse(
                (response) =>
                  /\/items$/.test(new URL(response.url()).pathname) &&
                  response.request().method() === "POST",
              ),
              page.getByRole("button", { name: "Add to cart", exact: true }).click(),
            ]);
            check(added.status() === 200, "ADD_STATUS");
            const addedBody = await added.json();
            check(!cartReferences.has(addedBody.cart.cartReference), "CONTEXT_ISOLATION");
            cartReferences.add(addedBody.cart.cartReference);
            const [cartRead] = await Promise.all([
              page.waitForResponse(
                (response) => new URL(response.url()).pathname === "/bff/customer/cart",
              ),
              page.getByRole("link", { name: "Review cart", exact: true }).click(),
            ]);
            check(cartRead.status() === 200, "CART_READ_STATUS");
            const cartReadBody = await cartRead.json();
            check(cartReadBody.cart.items.length === 1, "CART_READ_ITEMS");
            check(cartReadBody.cart.items[0].displayName === "Synthetic drink", "CART_READ_LABEL");
            phase = "CART";
            await page.getByRole("heading", { name: "Synthetic drink", exact: true }).waitFor();
            const increase = page.getByRole("button", {
              name: "Increase Synthetic drink quantity",
              exact: true,
            });
            phase = "UPDATE";
            const [updated] = await Promise.all([
              page.waitForResponse((response) => response.request().method() === "PATCH"),
              increase.click(),
            ]);
            check(updated.status() === 200, "UPDATE_STATUS");
            phase = "QUANTITY";
            await page
              .getByLabel("Synthetic drink quantity", { exact: true })
              .filter({ hasText: "2" })
              .waitFor();
            phase = "FRESH_PAGE_CSRF";
            const freshPage = await context.newPage();
            await freshPage.goto(`${origin}/cart`);
            await freshPage.reload();
            await freshPage
              .getByLabel("Synthetic drink quantity", { exact: true })
              .filter({ hasText: "2" })
              .waitFor();
            await freshPage
              .getByRole("button", { name: "Increase Synthetic drink quantity", exact: true })
              .click();
            await freshPage
              .getByRole("heading", { name: "Session expired", exact: true })
              .waitFor();
            const unchanged = await admin.query(
              "SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1",
              [addedBody.cart.cartReference],
            );
            check(unchanged.rows[0]?.aggregate_version === 3, "CSRF_REFRESH_WRITE");
            await freshPage.close();
            phase = "OFFLINE";
            await context.setOffline(true);
            await page.waitForFunction(
              () =>
                [...globalThis.document.querySelectorAll("button")].find(
                  (button) =>
                    button.getAttribute("aria-label") === "Increase Synthetic drink quantity",
                )?.disabled === true,
            );
            await context.setOffline(false);
            await page
              .getByRole("button", { name: "Refresh after reconnecting", exact: true })
              .click();
            await increase.waitFor();
            phase = "REMOVE";
            const [removed] = await Promise.all([
              page.waitForResponse((response) => response.request().method() === "DELETE"),
              page.getByRole("button", { name: "Remove", exact: true }).click(),
            ]);
            check(removed.status() === 200, "REMOVE_STATUS");
            await page.getByText("0 item lines", { exact: true }).waitFor();
            phase = "RELOAD";
            await page.reload();
            await page.getByText("0 item lines", { exact: true }).waitFor();
            const rows = await admin.query(
              "SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1",
              [addedBody.cart.cartReference],
            );
            check(rows.rows[0]?.aggregate_version === 4, "PERSISTED_VERSION");
            const operations = await admin.query(
              "SELECT count(*)::integer AS count FROM rms_ordering.cart_operation_record WHERE cart_id=$1",
              [addedBody.cart.cartReference],
            );
            check(operations.rows[0].count === 3, "DUPLICATE_COMMAND");
            const audits = await admin.query(
              "SELECT count(*)::integer AS count FROM platform_audit.audit_record WHERE target_id=$1",
              [addedBody.cart.cartReference],
            );
            check(audits.rows[0].count === 4, "AUDIT_COUNT");
            await page.waitForFunction(
              async () =>
                (await globalThis.navigator.serviceWorker.getRegistration())?.active?.state ===
                "activated",
            );
            const privacy = await page.evaluate(async () => ({
              cookie: globalThis.document.cookie,
              html: globalThis.document.documentElement.outerHTML,
              local: globalThis.localStorage.length,
              session: globalThis.sessionStorage.length,
              databases: (await globalThis.indexedDB.databases()).length,
              cached: (
                await Promise.all(
                  (await globalThis.caches.keys()).map(async (key) =>
                    (await (await globalThis.caches.open(key)).keys()).map(
                      (request) => request.url,
                    ),
                  ),
                )
              ).flat(),
            }));
            check(
              privacy.cookie === "" &&
                privacy.local === 0 &&
                privacy.session === 0 &&
                privacy.databases === 0,
              "PRIVATE_STORAGE",
            );
            check(!new URL(page.url()).hash && !new URL(page.url()).search, "PRIVATE_URL");
            for (const secret of [token, cookie.value, entryBody.csrfToken]) {
              check(
                !privacy.html.includes(secret) && logs.every((line) => !line.includes(secret)),
                "PRIVATE_LEAK",
              );
            }
            check(
              privacy.cached.every((value) => !/\/(?:api|bff)\//.test(new URL(value).pathname)),
              "PRIVATE_CACHE",
            );
            check(
              await page.evaluate(
                () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
              ),
              "HORIZONTAL_OVERFLOW",
            );
            await context.close();
          }
          check(violations.length === 0, "BROWSER_VIOLATION");
        },
        { cartJourney: true },
      );
    } catch (error) {
      if (error instanceof Error && /^WP2222_[A-Z_]+$/.test(error.message)) throw error;
      // Raw browser and database errors can contain private URLs or credentials.
      check(false, `BROWSER_${phase}_FAILED`);
    } finally {
      await admin.query("ROLLBACK");
      await Promise.all(pools.map((pool) => pool.end()));
      try {
        if (roleCreated) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      } finally {
        await admin.end();
      }
    }
  });
});
