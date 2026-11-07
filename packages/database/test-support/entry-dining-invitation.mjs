import assert from "node:assert/strict";
import { createGuestDiningBindingCredentialProvider } from "../../bop/identity/src/index.ts";
import { createPostgresDiningQrJoinStore } from "../../rms/dining/src/index.ts";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { createInternalCustomerEntry } from "../../../tooling/environment/pilot-customer-entry.mjs";
import { grantPilotApiAcl } from "./pilot-api-acl.mjs";

/**
 * WP-2423 DEC-DINING-GUEST-INVITATION (v15 8c4480dd H1): the Host's "Make a code" over the real
 * composed API. The invitation options come from the pilot's own `createInternalCustomerEntry`
 * (only its Store-specific loaders are test inputs) and are served by `createLocalCustomerRuntime`,
 * exactly as `pilot-api.mjs` does; guests are real Guest Sessions bound to the table through the
 * actual Join and binding HTTP routes, and every owner runs as the restricted role holding the
 * rendered pilot api grants.
 */
export async function exerciseEntryDiningInvitation({
  admin,
  role,
  run,
  scope,
  at,
  key,
  credentials,
  session,
  contextsForTransaction,
  reference,
  runtimeOptions,
  host,
  base,
  joinAndBind,
  enterAnother,
  rescan,
  staffReplace,
}) {
  // The pilot api grants, including SELECT, INSERT on dining_guest_invitation_operation.
  await grantPilotApiAcl(admin, role);
  const identityScope = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  const resources = {
    transactions: { run },
    scope: identityScope,
    now: () => at,
    credentials: { sessions: session.credentials, reference },
  };
  // Test inputs replace only the Store-specific loaders (QR files, keys, staff session); the
  // binding, invitation and admission wiring is the pilot's own.
  const contexts = (runner) => ({
    resolve: (input) => runner.run((tx) => contextsForTransaction(tx).resolve(input)),
    validate: (guest, observedAt) =>
      runner.run((tx) => contextsForTransaction(tx).validate(guest, observedAt)),
  });
  const configured = await createInternalCustomerEntry(resources, {
    createInternalPickupEntry: async () => ({
      binding: () => ({ validate: async () => "Unavailable" }),
      entry: { persistent: {} },
    }),
    createInternalDiningEntries: async () => ({ binding: contexts }),
    createInternalMerchantSession: async () => ({}),
    createInternalDiningSession: async () => ({
      scope,
      credentials: {
        ...credentials,
        bindingRecovery: createGuestDiningBindingCredentialProvider(key),
      },
      stores: { join: null },
    }),
  });
  const runtime = createLocalCustomerRuntime({
    ...runtimeOptions,
    diningInvitation: configured.diningInvitation,
    runtime: { port: 0, logger: createApiRuntimeLogger({ write: () => undefined }) },
  });
  await runtime.listen();
  try {
    const url = "http://127.0.0.1:" + runtime.server.address().port + "/api/v1/dine-in/invitation";
    const headers = (guest) => ({
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      cookie: guest.cookie,
      "x-csrf-token": guest.csrfToken,
    });
    const canInvite = async (guest) => {
      const response = await globalThis.fetch(url, { headers: headers(guest) });
      assert.equal(response.status, 200, "a joined guest reads whether they may invite");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.deepEqual(Object.keys(body.invitation), ["canInvite"]);
      return body.invitation.canInvite;
    };
    const issue = (guest, operation = reference()) =>
      globalThis.fetch(url, {
        method: "POST",
        headers: {
          ...headers(guest),
          origin: runtimeOptions.allowedOrigin,
          "content-type": "application/json",
          "idempotency-key": operation,
        },
        body: "{}",
      });
    const issued = async (guest, operation = reference()) => {
      const response = await issue(guest, operation);
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.invitation.status, "Issued");
      assert.match(body.invitation.code, /^[0-9]{6}$/u);
      return body.invitation.code;
    };
    // v15 42e95248: the Host's phone asks what became of the code it shows by the request that
    // made it; the answer never carries the code.
    const codeState = async (guest, operation, shown) => {
      const response = await globalThis.fetch(url, {
        headers: { ...headers(guest), "x-dining-invitation-reference": operation },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text();
      if (shown !== undefined) assert.equal(text.includes(shown), false, "the code is not re-sent");
      const body = JSON.parse(text);
      assert.deepEqual(Object.keys(body.invitation), ["canInvite", "codeState"]);
      return body.invitation.codeState;
    };
    const join = async (guest, joinCredential) => {
      const response = await globalThis.fetch(base + "/bff/customer/dining/join", {
        method: "POST",
        headers: {
          origin: runtimeOptions.allowedOrigin,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "content-type": "application/json",
          cookie: guest.cookie,
          "x-csrf-token": guest.csrfToken,
          "idempotency-key": reference(),
        },
        body: JSON.stringify({ joinCredential }),
      });
      return { status: response.status, body: await response.json() };
    };
    const issuedRows = async () =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM rms_dining.dining_guest_invitation_operation WHERE brand_id=$1 AND store_id=$2",
          [scope.brandReference, scope.storeReference],
        )
      ).rows[0].n;

    // The Host, just joined with the staff code, sees "Make a code" and makes one.
    assert.equal(await canInvite(host), true);
    const firstOperation = reference();
    const code = await issued(host, firstOperation);
    assert.equal(await issuedRows(), 1);
    assert.equal(await codeState(host, firstOperation, code), "Live");
    // A request reference this guest never used reads as unknown, not as someone else's code.
    assert.equal(await codeState(host, reference()), "Unknown");
    // A second guest scans the table QR and joins with the Host's code.
    const second = await enterAnother(base);
    const joined = await joinAndBind(second.cookie, second.csrfToken, code);
    const guest = { cookie: joined.currentCookie, csrfToken: joined.activation.csrfToken };
    // The Host's phone learns the code was used, without a reload.
    assert.equal(await codeState(host, firstOperation, code), "Used");
    // Another guest cannot learn about the Host's code by its request reference.
    assert.equal(await codeState(guest, firstOperation, code), "Unknown");
    // Only the Host invites: the new guest sees no control and is refused if they try.
    assert.equal(await canInvite(guest), false);
    const refused = await issue(guest);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, "dining_invitation_not_host");
    assert.equal(await issuedRows(), 1);
    // The code worked once: a third phone cannot reuse it.
    const third = await enterAnother(base);
    const reused = await join(third, code);
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.messageKey, "customer.dining.join_code_used");
    if (rescan !== undefined) {
      // WP-2423 shared-table-checkout (b): the entry served with the pilot's own Dining admission
      // wiring, so a re-scan's presented cookie is read exactly as pilot-api.mjs composes it.
      const entryLogs = [];
      const entryRuntime = createLocalCustomerRuntime({
        ...runtimeOptions,
        // The pilot's own Guest Session binding check (this journey's entry otherwise uses a
        // pickup-only one, which no seated phone passes).
        entry: {
          ...runtimeOptions.entry,
          session: { ...runtimeOptions.entry.session, binding: configured.binding({ run }) },
        },
        diningAdmission: configured.diningAdmission,
        runtime: {
          port: 0,
          logger: createApiRuntimeLogger({ write: (line) => entryLogs.push(String(line)) }),
        },
      });
      await entryRuntime.listen();
      try {
        await exerciseAlreadyAtTable({
          admin,
          scope,
          at,
          session,
          credentials,
          reference,
          run,
          rescan: (cookie) =>
            rescan("http://127.0.0.1:" + entryRuntime.server.address().port, cookie),
          host,
          guest,
        });
      } catch (error) {
        // The request log carries safe failure codes only (no token, cookie or reference).
        error.message += " | entry log: " + entryLogs.slice(-5).join(" || ");
        throw error;
      } finally {
        await entryRuntime.shutdown("SIGTERM");
      }
    }
    // Staff replacing the table code voids the Host's unused one.
    // A code made again (say from the Host's other tab) replaces the one shown before.
    const replacedOperation = reference();
    const replaced = await issued(host, replacedOperation);
    const unusedOperation = reference();
    const unused = await issued(host, unusedOperation);
    assert.equal(await issuedRows(), 3);
    assert.equal(await codeState(host, replacedOperation, replaced), "Replaced");
    assert.equal(await codeState(host, unusedOperation, unused), "Live");
    await staffReplace();
    // Staff replacing the table code: the Host's phone is told, before anyone tries the code.
    assert.equal(await codeState(host, unusedOperation, unused), "Replaced");
    const voided = await join(third, unused);
    assert.equal(voided.status, 409);
    assert.equal(voided.body.error.messageKey, "customer.dining.join_code_not_accepted");
    // The code never reaches the audit record or the operation history.
    const stored = await admin.query(
      "SELECT record_json::text AS record FROM rms_dining.dining_guest_invitation_operation WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, scope.storeReference],
    );
    for (const row of stored.rows) {
      assert.equal(row.record.includes(code), false);
      assert.equal(row.record.includes(unused), false);
      assert.equal(row.record.includes(replaced), false);
    }
  } finally {
    await runtime.shutdown("SIGTERM");
  }
}

/**
 * WP-2423 shared-table-checkout (b), as the restricted role with the rendered pilot api grants,
 * through the pilot's own entry and Dining admission composition and the persistent entry (whose
 * transaction is rolled back for every answer but Established):
 * - a seated phone scanning its table's QR again presents its real cookie and gets 200
 *   AlreadyAtTable: no Guest Session, entry admission, participant or Dining admission is written
 *   and no cookie is set;
 * - after staff remove a phone (its participant Left), its cookie is an ordinary entry (a new
 *   context-only visit; it must join again, subject to the table's scan pause);
 * - a cookie this Store's Identity doesn't hold (unknown here, as another Store's is: Identity reads
 *   are Store-scoped) is an ordinary entry.
 */
async function exerciseAlreadyAtTable({
  admin,
  scope,
  at,
  session,
  credentials,
  reference,
  run,
  rescan,
  host,
  guest,
}) {
  const rows = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*) FROM bop_identity.guest_session WHERE brand_id=$1 AND store_id=$2)::int AS sessions," +
          " (SELECT count(*) FROM bop_identity.guest_entry_admission WHERE brand_id=$1 AND store_id=$2)::int AS admissions," +
          " (SELECT count(*) FROM rms_dining.dining_participant WHERE brand_id=$1 AND store_id=$2)::int AS participants," +
          " (SELECT count(*) FROM rms_dining.dining_identity_admission WHERE brand_id=$1 AND store_id=$2)::int AS diningAdmissions",
        [scope.brandReference, scope.storeReference],
      )
    ).rows[0];
  const guestCookies = (response) =>
    response.headers.getSetCookie().filter((value) => value.startsWith("__Host-bop-guest="));

  const before = await rows();
  const again = await rescan(host.cookie);
  const body = await again.json();
  assert.equal(
    again.status,
    200,
    "a seated phone re-scanning is told it is already there: " + JSON.stringify(body),
  );
  assert.equal(body.status, "AlreadyAtTable");
  assert.equal(body.channel, "DineIn");
  assert.equal(Object.hasOwn(body, "csrfToken"), false);
  assert.deepEqual(guestCookies(again), []);
  assert.deepEqual(await rows(), before, "nothing is written for a re-scan");

  // Staff take the second phone off the table (Tables -> Table phones -> Remove).
  // The second phone is the one bound to the table most recently (the Host bound first).
  const located = await admin.query(
    "SELECT dining_session_id, dining_participant_id FROM bop_identity.guest_session WHERE brand_id=$1 AND store_id=$2 AND dining_state='DiningBound' AND status='Active' ORDER BY created_at DESC, guest_session_id DESC LIMIT 1",
    [scope.brandReference, scope.storeReference],
  );
  assert.equal(located.rows.length, 1);
  const removed = await createPostgresDiningQrJoinStore(
    { run },
    {
      scope,
      credentials,
      pepperVersion: 1,
      now: () => at,
      authorize: async () => true,
      audit: (record) => ({
        auditId: reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: reference() },
        actionCode: "DINING_PARTICIPANT_REMOVE",
        targetType: "DiningTable",
        targetId: record.tableReference,
        reasonCode: "STAFF_TABLE_CONTROL",
        correlationId: record.operationReference,
        occurredAt: record.observedAt,
        sourceChannel: "API",
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
  ).remove({
    operationReference: reference(),
    diningSessionReference: located.rows[0].dining_session_id,
    participantReference: located.rows[0].dining_participant_id,
    actorReference: reference(),
    observedAt: at,
  });
  assert.equal(removed.status, "Removed");
  const afterRemove = await rows();
  const fallsThrough = await rescan(guest.cookie);
  assert.equal(fallsThrough.status, 201, "a removed phone's scan is an ordinary entry");
  const fallsThroughBody = await fallsThrough.json();
  assert.equal(fallsThroughBody.status, "Established");
  assert.equal(guestCookies(fallsThrough).length, 1);
  const afterRejoin = await rows();
  assert.equal(afterRejoin.sessions, afterRemove.sessions + 1);
  assert.equal(afterRejoin.admissions, afterRemove.admissions + 1);
  assert.equal(afterRejoin.participants, afterRemove.participants);

  const stranger = await rescan("__Host-bop-guest=" + "A".repeat(43));
  assert.equal(stranger.status, 201, "a cookie this Store doesn't hold is an ordinary entry");
  assert.equal((await stranger.json()).status, "Established");
  // The seated Host is still told it is there.
  const hostAgain = await rescan(host.cookie);
  assert.equal(hostAgain.status, 200);
  assert.equal((await hostAgain.json()).status, "AlreadyAtTable");
}
