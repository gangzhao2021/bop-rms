import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
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
const id = (n) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
function check(value, code) {
  if (!value) throw new Error(`WP2221_${code}`);
}
it("reads real persisted Item mutations through authorized HTTP with unquoted state and public Catalog names", async () => {
  await withIsolatedDatabase({ workPackage: "WP-2221" }, async (database) => {
    const admin = new Client(database.clientConfig);
    const pools = [];
    const role = `bop_wp2221_${database.runId}`;
    const logs = [];
    let runtime;
    let roleCreated = false;
    let phase = "SETUP";
    let sequence = 100;
    let observedAt = at;
    let bindingCurrent = true;
    let displayAvailable = true;
    let selectionRejected = false;
    let catalogState = "Current";
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
          application_name: "bop_wp2221_acceptance",
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
                throw new Error("WP2221_ROLE_FAILED");
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
      function sessionService() {
        return new GuestSessionService({
          credentials,
          store: createPostgresGuestSessionEntryStore(runner(), scope),
          binding: {
            async validate() {
              return bindingCurrent ? "Current" : "Unavailable";
            },
          },
          admission: {
            async consume(command) {
              return {
                decision: "Allowed",
                evidenceReference: id(5),
                entryRequestReference: command.entryRequestReference,
                ...scope,
                publicStoreReference: id(3),
                publicTableReference: null,
                channel: "Pickup",
                locale: "en-CA",
                qrReference: id(4),
                qrRevocationVersion: 1,
                evaluatedAt: at,
                validUntil: "2026-08-02T14:01:00.000Z",
              };
            },
          },
          now: () => observedAt,
        });
      }
      const issuing = sessionService();
      const first = await issuing.create({
        entryRequestReference: id(10),
        operationReference: id(11),
        requestedAt: at,
      });
      const second = await issuing.create({
        entryRequestReference: id(12),
        operationReference: id(13),
        requestedAt: at,
      });
      check(first.status === "Issued" && second.status === "Issued", "SESSION_NOT_ISSUED");
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
            channelCodes: ["SYNTHETIC_QR"],
            orderTypeCodes: ["SYNTHETIC_PICKUP"],
            timeZone: "America/Toronto",
            effectiveFrom: "2026-08-02T13:00:00.000Z",
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
            return reference === id(3) ? { ...scope, status: "Active" } : null;
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
      const origin = "https://customer.invalid";
      runtime = createApiServerRuntime({
        port: 0,
        host: "127.0.0.1",
        logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
        customerCart: new CustomerCartHandler({
          port: composition,
          allowedOrigin: origin,
          now: () => observedAt,
        }),
      });
      await runtime.listen();
      const address = runtime.server.address();
      check(address !== null && typeof address === "object", "LISTENER_UNAVAILABLE");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = (session) => ({
        cookie: `__Host-bop-guest=${session.sessionCredential}`,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      });
      async function request(
        path,
        session = first,
        mutation = false,
        overrides = {},
        payload = {},
      ) {
        const response = await globalThis.fetch(base + path, {
          method: typeof mutation === "string" ? mutation : mutation ? "POST" : "GET",
          headers: {
            ...headers(session),
            ...(mutation
              ? {
                  origin,
                  "content-type": "application/json",
                  "x-csrf-token": session.csrfCredential,
                  "idempotency-key": id(20),
                }
              : {}),
            ...overrides,
          },
          ...(mutation ? { body: JSON.stringify(payload) } : {}),
          signal: globalThis.AbortSignal.timeout(5000),
        });
        const text = await response.text();
        check(response.headers.get("cache-control") === "no-store", "CACHEABLE_RESPONSE");
        for (const secret of [
          first.sessionCredential,
          first.csrfCredential,
          second.sessionCredential,
          second.csrfCredential,
          "brandReference",
          "policyDigest",
          "operationIntentHash",
          "createdByActorReference",
          "PRICING_NOT_INTEGRATED",
          "quoteAbsenceVerified",
          "presentationSnapshot",
        ])
          check(!text.includes(secret), "PRIVATE_RESPONSE");
        return { response, body: JSON.parse(text) };
      }
      const quoteStore = createPostgresCartPresentationStore({ ...scope, runner: runner() });
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
                catalogChannelCode: "SYNTHETIC_QR",
                catalogOrderTypeCode: "SYNTHETIC_PICKUP",
                ruleEvidence: [{ bindingReference: id(521), optionSetVersionReference: id(522) }],
                validatedAt: input.observedAt,
              };
            },
          },
        };
      }
      async function itemRequest(method, input, session = first, overrides = {}) {
        const { cartReference, cartItemReference, expectedAggregateVersion, operationReference } =
          input;
        const payload =
          method === "remove"
            ? {}
            : {
                quantity: input.quantity,
                optionSelections: input.optionSelections,
                customerNote: input.customerNote,
                ...(method === "add" ? { sellableReference: input.sellableReference } : {}),
              };
        const path = `/api/v1/carts/${cartReference}/items${method === "add" ? "" : `/${cartItemReference}`}`;
        return request(
          path,
          session,
          method === "add" ? "POST" : method === "update" ? "PATCH" : "DELETE",
          {
            "if-match": `"${expectedAggregateVersion}"`,
            "idempotency-key": operationReference,
            ...overrides,
          },
          payload,
        );
      }
      const mutations = Object.fromEntries(
        ["add", "update", "remove"].map((method) => [
          method,
          async (input) => {
            const result = await itemRequest(method, input);
            check(result.response.status === 200, "HTTP_ITEM_COMMAND");
            check(
              result.response.headers.get("etag") === `"${result.body.cart.version}"`,
              "ITEM_ETAG",
            );
            return {
              cartItemReference:
                method === "add"
                  ? result.body.cart.items.at(-1).cartItemReference
                  : input.cartItemReference,
              view: result.body,
            };
          },
        ]),
      );
      async function counts() {
        return (
          await admin.query(`SELECT
          (SELECT count(*)::integer FROM rms_ordering.cart_operation_record) AS operations,
          (SELECT sum(aggregate_version)::integer FROM rms_ordering.cart) AS cart_versions,
          (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits,
          (SELECT sum(version)::integer FROM bop_identity.guest_session) AS session_versions`)
        ).rows[0];
      }
      async function readOnly(path, expectedStatus = 200, session = first) {
        const before = JSON.stringify(await counts());
        const result = await request(path, session);
        check(result.response.status === expectedStatus, "READ_STATUS");
        check(JSON.stringify(await counts()) === before, "READ_MUTATED_FACTS");
        if (expectedStatus !== 200)
          check(!JSON.stringify(result.body).includes("Synthetic napkins"), "NOTE_IN_ERROR");
        return result.body;
      }
      async function controlled(action) {
        let denied = false;
        try {
          await action();
        } catch (error) {
          denied = error?.code === "CART_DEPENDENCY_UNAVAILABLE";
        }
        check(denied, "PROOF_DENIAL");
      }
      phase = "CREATE";
      const created = await request("/api/v1/carts", first, true);
      check(created.response.status === 201, "CREATE_FAILED");
      const cartId = created.body.cart.cartReference;
      phase = "PERSISTED_ADD_READ";
      observedAt = "2026-08-02T14:00:01.000Z";
      const add = {
        cartReference: cartId,
        expectedAggregateVersion: 1,
        sellableReference: id(507),
        quantity: 2,
        optionSelections: [{ optionReference: id(508), quantity: 1 }],
        customerNote: "Synthetic napkins",
        operationReference: id(41),
        requestedAt: observedAt,
      };
      const added = await mutations.add(add);
      const view = await readOnly("/bff/customer/cart");
      check(
        view.cart.version === 2 && view.cart.items.length === 1 && view.cart.quote === null,
        "NONEMPTY_VIEW",
      );
      check(
        view.cart.items[0].displayName === "Synthetic drink" &&
          view.cart.items[0].quantity === 2 &&
          view.cart.items[0].configuration[0].displayName === "Synthetic option" &&
          view.cart.items[0].customerNote === "Synthetic napkins" &&
          view.cart.items[0].lineEstimate.status === "Unavailable",
        "SOURCE_MAPPING",
      );
      phase = "DENIED_SOURCES";
      for (const state of ["Missing", "Stale", "Changed"]) {
        catalogState = state;
        await readOnly("/bff/customer/cart", 503);
      }
      catalogState = "Current";
      await readOnly(`/api/v1/carts/${cartId}`, 404, second);
      await readOnly("/bff/customer/cart", 404, second);
      displayAvailable = false;
      await readOnly("/bff/customer/cart", 503);
      displayAvailable = true;
      bindingCurrent = false;
      await readOnly("/bff/customer/cart", 401);
      bindingCurrent = true;
      phase = "PERSISTED_UPDATE_READ";
      observedAt = "2026-08-02T14:00:02.000Z";
      await mutations.update({
        cartReference: cartId,
        cartItemReference: added.cartItemReference,
        expectedAggregateVersion: 2,
        quantity: 3,
        optionSelections: [],
        customerNote: null,
        operationReference: id(42),
        requestedAt: observedAt,
      });
      const updated = await readOnly(`/api/v1/carts/${cartId}`);
      check(
        updated.cart.version === 3 &&
          updated.cart.items[0].quantity === 3 &&
          updated.cart.items[0].configuration.length === 0,
        "UPDATE_NOT_VISIBLE",
      );
      phase = "PERSISTED_REMOVE_READ";
      observedAt = "2026-08-02T14:00:03.000Z";
      await mutations.remove({
        cartReference: cartId,
        cartItemReference: added.cartItemReference,
        expectedAggregateVersion: 3,
        operationReference: id(43),
        requestedAt: observedAt,
      });
      const empty = await readOnly("/bff/customer/cart");
      check(empty.cart.version === 4 && empty.cart.items.length === 0, "CHANGED_EMPTY_NOT_VISIBLE");
      phase = "HTTP_RETRY_AND_DENIAL";
      const mutationCounts = async () => {
        const facts = await counts();
        return JSON.stringify([facts.operations, facts.cart_versions, facts.audits]);
      };
      const beforeRetries = await mutationCounts();
      catalogState = "Missing";
      displayAvailable = false;
      const replayed = await itemRequest("add", add);
      check(
        replayed.response.status === 200 &&
          JSON.stringify(replayed.body) === JSON.stringify(added.view),
        "ORIGINAL_HTTP_REPLAY",
      );
      check((await mutationCounts()) === beforeRetries, "REPLAY_MUTATED_CART");
      const nextAdd = { ...add, expectedAggregateVersion: 4, operationReference: id(46) };
      check(
        (await itemRequest("add", nextAdd)).response.status === 503,
        "SOURCE_FAILURE_ALLOWED_WRITE",
      );
      displayAvailable = true;
      check(
        (await itemRequest("add", nextAdd)).response.status === 503,
        "CATALOG_FAILURE_ALLOWED_WRITE",
      );
      catalogState = "Current";
      check(
        (await itemRequest("add", { ...add, quantity: 3 })).response.status === 409,
        "CHANGED_INTENT_ALLOWED",
      );
      check(
        (await itemRequest("add", { ...add, operationReference: id(47) })).response.status === 409,
        "STALE_VERSION_ALLOWED",
      );
      check(
        (await itemRequest("add", nextAdd, second)).response.status === 404,
        "FOREIGN_CART_WRITE",
      );
      check(
        (
          await itemRequest("remove", {
            cartReference: cartId,
            cartItemReference: id(999),
            expectedAggregateVersion: 4,
            operationReference: id(48),
          })
        ).response.status === 404,
        "FOREIGN_ITEM_WRITE",
      );
      check(
        (await itemRequest("add", nextAdd, first, { origin: "https://foreign.invalid" })).response
          .status === 400,
        "ORIGIN_WRITE_ALLOWED",
      );
      check(
        (
          await itemRequest("add", nextAdd, first, {
            "x-csrf-token":
              (first.csrfCredential[0] === "A" ? "B" : "A") + first.csrfCredential.slice(1),
          })
        ).response.status === 401,
        "CSRF_WRITE_ALLOWED",
      );
      bindingCurrent = false;
      check((await itemRequest("add", nextAdd)).response.status === 401, "REVOKED_WRITE_ALLOWED");
      bindingCurrent = true;
      selectionRejected = true;
      check((await itemRequest("add", nextAdd)).response.status === 422, "SELECTION_WRITE_ALLOWED");
      selectionRejected = false;
      check((await mutationCounts()) === beforeRetries, "DENIAL_MUTATED_CART");
      phase = "PROOF_SCOPE";
      const proof = { ...scope, cartReference: cartId, cartVersion: 4 };
      await controlled(() => quoteStore.resolve({ ...proof, cartVersion: 1 }));
      await controlled(() => quoteStore.resolve({ ...proof, cartReference: id(999) }));
      await controlled(() => quoteStore.resolve({ ...proof, storeReference: id(999) }));
      const foreign = createPostgresCartPresentationStore({
        ...scope,
        brandReference: id(999),
        runner: runner(),
      });
      await controlled(() => foreign.resolve({ ...proof, brandReference: id(999) }));
      phase = "CONCURRENT_QUOTE_ATTACHMENT";
      observedAt = "2026-08-02T14:00:04.000Z";
      await mutations.add({
        ...add,
        expectedAggregateVersion: 4,
        operationReference: id(44),
        requestedAt: observedAt,
      });
      const currentProof = { ...proof, cartVersion: 5 };
      await admin.query("BEGIN");
      await admin.query("SELECT cart_id FROM rms_ordering.cart WHERE cart_id=$1 FOR UPDATE", [
        cartId,
      ]);
      phase = "WAIT_FOR_CART_LOCK";
      const beforeQuoteWrite = await mutationCounts();
      const quotedInput = {
        ...add,
        expectedAggregateVersion: 5,
        operationReference: id(49),
        requestedAt: observedAt,
      };
      const pendingMutation = itemRequest("add", quotedInput);
      const pending = quoteStore.resolve(currentProof);
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const waiters = await admin.query(`SELECT count(*)::integer AS count FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database()`);
        if (waiters.rows[0].count > 0) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      check(waiting, "READER_DID_NOT_WAIT_FOR_CART");
      phase = "INSERT_SYNTHETIC_QUOTE";
      // Synthetic attachment setup proves absence detection, not a real Pricing/Quote write.
      await admin.query(
        `INSERT INTO rms_ordering.cart_quote_attachment
        (operation_id,brand_id,store_id,cart_id,cart_version,guest_session_id,intent_digest,quote_id,quote_version,
         quote_input_digest,currency_code,currency_metadata_version,currency_metadata_version_id,
         subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,line_count,warnings_json,
         quote_created_at,quote_expires_at,attached_at,idempotency_expires_at)
        VALUES ($1,$2,$3,$4,5,$5,$6,$7,1,$6,'CAD',1,$8,0,0,0,0,0,1,'[]',$9,$10,$9,$11)`,
        [
          id(80),
          scope.brandReference,
          scope.storeReference,
          cartId,
          first.session.sessionReference,
          `sha256:${"c".repeat(64)}`,
          id(81),
          id(82),
          observedAt,
          "2026-08-02T14:30:00.000Z",
          "2026-08-03T14:00:04.000Z",
        ],
      );
      await admin.query("COMMIT");
      phase = "READ_AFTER_ATTACHMENT";
      check((await pendingMutation).response.status === 503, "QUOTED_WRITE_ALLOWED");
      check((await mutationCounts()) === beforeQuoteWrite, "QUOTED_WRITE_MUTATED");
      catalogState = "Missing";
      displayAvailable = false;
      const originalAfterQuote = await itemRequest("add", add);
      check(
        originalAfterQuote.response.status === 200 &&
          JSON.stringify(originalAfterQuote.body) === JSON.stringify(added.view),
        "ORIGINAL_REPLAY_AFTER_QUOTE",
      );
      catalogState = "Current";
      displayAvailable = true;
      check((await pending).quoteStatus === "Present", "ATTACHMENT_HIDDEN_BY_OLD_SNAPSHOT");
      await readOnly("/bff/customer/cart", 503);
      // A later Cart version must not hide earlier immutable attachments either.
      await admin.query("UPDATE rms_ordering.cart SET aggregate_version=6 WHERE cart_id=$1", [
        cartId,
      ]);
      check(
        (await quoteStore.resolve({ ...currentProof, cartVersion: 6 })).quoteStatus === "Present",
        "OLDER_QUOTE_HIDDEN",
      );
      await readOnly(`/api/v1/carts/${cartId}`, 503);
      const beforeOldQuote = await mutationCounts();
      check(
        (
          await itemRequest("add", {
            ...quotedInput,
            expectedAggregateVersion: 6,
            operationReference: id(50),
          })
        ).response.status === 503,
        "OLDER_QUOTE_WRITE_ALLOWED",
      );
      check((await mutationCounts()) === beforeOldQuote, "OLDER_QUOTE_WRITE_MUTATED");
      for (const secret of [
        first.sessionCredential,
        first.csrfCredential,
        second.sessionCredential,
        second.csrfCredential,
        cartId,
        first.session.sessionReference,
        "Synthetic napkins",
      ])
        check(
          logs.every((line) => !line.includes(secret)),
          "PRIVATE_LOG",
        );
    } catch {
      throw new Error(`WP2221_HTTP_${phase}_FAILED`);
    } finally {
      await admin.query("ROLLBACK");
      if (runtime) await runtime.shutdown("SIGTERM");
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
