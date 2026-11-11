import { setTimeout as delay } from "node:timers/promises";
import { it } from "vitest";
import { withAutoAcceptWorld } from "../test-support/auto-accept-world.mjs";
import { createMerchantStoreFeatures } from "../../../apps/api/src/merchant-store-features.ts";
import { createMerchantStorePublicProfile } from "../../../apps/api/src/merchant-store-public-profile.ts";
import { createStoreConfigurationVersion } from "../../rms/store/src/index.ts";
import { storeConfigurationPublicationChecks } from "../../../tooling/environment/pilot-store-publication.mjs";

/**
 * DEC-STORE-PHONE-BEFORE-PICKUP (M109), under the restricted NOBYPASSRLS role with the rendered
 * pilot ACL: turning pickup on reads the Store's published phone, and leaving the profile without
 * a phone reads whether pickup is on. Two owners saving at the same moment must not leave the
 * Store taking pickup orders with no phone a guest can call. Turning pickup on is held right
 * before it records the new setting; the profile edit runs meanwhile.
 */
const pausedBefore = (persistence, statement) => {
  let reached, release;
  const atStatement = new Promise((resolve) => (reached = resolve));
  const go = new Promise((resolve) => (release = resolve));
  return {
    atStatement,
    release: () => release(),
    persistence: {
      ...persistence,
      transactions: {
        ...persistence.transactions,
        run: (unit, ...rest) =>
          persistence.transactions.run(
            (tx) =>
              unit(
                new Proxy(tx, {
                  get(target, key, receiver) {
                    if (key !== "query") return Reflect.get(target, key, receiver);
                    return async (sql, values) => {
                      if (typeof sql === "string" && sql.startsWith(statement)) {
                        reached();
                        await go;
                      }
                      return target.query(sql, values);
                    };
                  },
                }),
              ),
            ...rest,
          ),
      },
    },
  };
};

it("M109: pickup turned on and the phone cleared at the same moment leave the phone on the profile", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_phone_race", orderType: "Pickup" }, async (world) => {
    const { assert, admin, fresh, ownerScope, query } = world;
    const owner = await world.session(
      ["organization.manage", "organization.store.read", "organization.store.publish"],
      "01a6aa08",
    );
    const profile = createMerchantStorePublicProfile({
      persistence: { ...owner.persistence, now: world.now },
      authentication: owner.authentication,
    });
    const details = (businessPhone) => ({
      storeDisplayNames: { "en-CA": "Synthetic Store" },
      address: {
        addressLines: ["1 Synthetic Street"],
        locality: "Ottawa",
        regionCode: "ON",
        postalCode: "K1A 0A1",
      },
      businessPhone,
    });
    // Pickup is off (owner record); the Store publishes its phone first.
    await admin.query(
      "INSERT INTO rms_store.store_feature_setting (tenant_id,brand_id,store_id,version,operation_id,template_code,counter_order,pickup,inventory,loyalty,compliance_documents,actor_id,occurred_at) VALUES ($1,$2,$3,1,$4,'Custom',true,false,true,true,true,$5,date_trunc('milliseconds',now()))",
      [
        ownerScope.tenantReference,
        ownerScope.brandReference,
        ownerScope.storeReference,
        fresh(),
        owner.actor,
      ],
    );
    const published = await profile({
      sessionCookie: owner.sessionCookie,
      csrf: owner.csrf,
      command: {
        expectedVersion: 0,
        operationReference: fresh(),
        details: details("613-555-0142"),
      },
    });
    assert.equal(published.status, "Published");
    assert.equal(published.current.businessPhone, "+16135550142");

    const paused = pausedBefore(
      { ...owner.persistence, now: world.now },
      "INSERT INTO rms_store.store_feature_setting",
    );
    const features = createMerchantStoreFeatures({
      persistence: paused.persistence,
      authentication: owner.authentication,
      now: world.now,
    });
    const turningOn = features({
      sessionCookie: owner.sessionCookie,
      csrf: owner.csrf,
      command: {
        action: "Change",
        operationReference: fresh(),
        expectedVersion: 1,
        modules: {
          counterOrder: true,
          pickup: true,
          inventory: true,
          loyalty: true,
          alcohol: false,
        },
      },
    });
    // Turning pickup on has read the phone and is about to record pickup on.
    await paused.atStatement;
    const clearing = profile({
      sessionCookie: owner.sessionCookie,
      csrf: owner.csrf,
      command: { expectedVersion: 1, operationReference: fresh(), details: details("") },
    });
    let clearSettled = false;
    void clearing.then(
      () => (clearSettled = true),
      () => (clearSettled = true),
    );
    // Either the edit finishes now (nothing holds it), or it waits on the Store's hold.
    for (let tries = 0; tries < 100 && !clearSettled; tries += 1) {
      const waiting = await admin.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
      );
      if (waiting.rows[0].n > 0) break;
      await delay(50);
    }
    paused.release();
    const [on, cleared] = await Promise.allSettled([turningOn, clearing]);
    assert.equal(on.status, "fulfilled", String(on.reason));
    assert.equal(on.value.modules.pickup, true);
    // The edit waited, then saw pickup on: refused, nothing published, the phone stays.
    assert.equal(cleared.status, "rejected", "the profile was published without a phone");
    assert.equal(cleared.reason?.code, "PhoneRequired");
    const now = await profile.read({ sessionCookie: owner.sessionCookie });
    assert.equal(now.current.businessPhone, "+16135550142");
    assert.deepEqual(
      await query(
        "SELECT version::int AS version,pickup FROM rms_store.store_feature_setting ORDER BY version",
      ),
      [
        { version: 1, pickup: false },
        { version: 2, pickup: true },
      ],
    );
  });
});

it("M109: the phone cleared first and pickup turned on meanwhile leave pickup off", async () => {
  await withAutoAcceptWorld(
    { caseId: "wp2423_phone_race2", orderType: "Pickup" },
    async (world) => {
      const { assert, admin, fresh, ownerScope, query } = world;
      const owner = await world.session(
        ["organization.manage", "organization.store.read", "organization.store.publish"],
        "01a6aa09",
      );
      const plain = { ...owner.persistence, now: world.now };
      const details = (businessPhone) => ({
        storeDisplayNames: { "en-CA": "Synthetic Store" },
        address: {
          addressLines: ["1 Synthetic Street"],
          locality: "Ottawa",
          regionCode: "ON",
          postalCode: "K1A 0A1",
        },
        businessPhone,
      });
      await admin.query(
        "INSERT INTO rms_store.store_feature_setting (tenant_id,brand_id,store_id,version,operation_id,template_code,counter_order,pickup,inventory,loyalty,compliance_documents,actor_id,occurred_at) VALUES ($1,$2,$3,1,$4,'Custom',true,false,true,true,true,$5,date_trunc('milliseconds',now()))",
        [
          ownerScope.tenantReference,
          ownerScope.brandReference,
          ownerScope.storeReference,
          fresh(),
          owner.actor,
        ],
      );
      const first = await createMerchantStorePublicProfile({
        persistence: plain,
        authentication: owner.authentication,
      })({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        command: {
          expectedVersion: 0,
          operationReference: fresh(),
          details: details("613-555-0142"),
        },
      });
      assert.equal(first.status, "Published");
      // The edit leaving no phone has read "pickup off" and is about to publish.
      const paused = pausedBefore(plain, "INSERT INTO rms_store.public_store_profile_version");
      const clearing = createMerchantStorePublicProfile({
        persistence: paused.persistence,
        authentication: owner.authentication,
      })({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        command: { expectedVersion: 1, operationReference: fresh(), details: details("") },
      });
      await paused.atStatement;
      const turningOn = createMerchantStoreFeatures({
        persistence: plain,
        authentication: owner.authentication,
        now: world.now,
      })({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        command: {
          action: "Change",
          operationReference: fresh(),
          expectedVersion: 1,
          modules: {
            counterOrder: true,
            pickup: true,
            inventory: true,
            loyalty: true,
            alcohol: false,
          },
        },
      });
      let onSettled = false;
      void turningOn.then(
        () => (onSettled = true),
        () => (onSettled = true),
      );
      for (let tries = 0; tries < 100 && !onSettled; tries += 1) {
        const waiting = await admin.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
        );
        if (waiting.rows[0].n > 0) break;
        await delay(50);
      }
      paused.release();
      const [cleared, on] = await Promise.allSettled([clearing, turningOn]);
      assert.equal(cleared.status, "fulfilled", String(cleared.reason));
      assert.equal(cleared.value.current.businessPhone, null);
      assert.equal(on.status, "rejected", "pickup was turned on with no phone on the profile");
      assert.equal(on.reason?.code, "STORE_FEATURES_PHONE_REQUIRED");
      assert.deepEqual(
        await query(
          "SELECT version::int AS version,pickup FROM rms_store.store_feature_setting ORDER BY version",
        ),
        [{ version: 1, pickup: false }],
      );
    },
  );
});

// The Store setup publication checks as the pilot composes them (tooling reads the phone from the
// Store's published profile in the caller's transaction, as the pilot API role).
it("M109: Store setup's check fails a setup that starts offering pickup until the store publishes a phone", async () => {
  await withAutoAcceptWorld(
    { caseId: "wp2423_phone_check", orderType: "Pickup" },
    async (world) => {
      const { assert, fresh, ownerScope, transactions } = world;
      const owner = await world.session(
        ["organization.manage", "organization.store.read", "organization.store.publish"],
        "01a6aa0a",
      );
      const id = (n) => "01902421-1013-7000-8000-" + n.toString(16).padStart(12, "0");
      const interval = (modes) => ({
        startLocalTime: "08:00:00",
        endLocalTime: "20:00:00",
        endsNextDay: false,
        serviceModes: modes,
        orderCutoffSeconds: 0,
        leadTimeSeconds: 0,
      });
      const week = (modes) =>
        Array.from({ length: 7 }, (_, i) => ({
          isoWeekday: i + 1,
          intervals: i === 0 ? [interval(modes)] : [],
        }));
      const shared = {
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        source: "StoreOverride",
        brandBaseVersionReference: id(11),
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        timeZone: "America/Toronto",
        businessDayStartLocalTime: "04:00:00",
        addressReference: id(12),
        contactReference: id(13),
        receiptReference: id(14),
        taxConfigurationReference: id(15),
        paymentConfigurationReference: id(16),
        capacityConfigurationReference: null,
        exceptions: [],
        effectiveUntil: null,
        authoredByReference: id(4),
        dataClassification: "ConfigurationMetadata",
      };
      const at = world.now();
      // The Store in force is dine-in only (TEST-ONLY synthetic configuration).
      const live = createStoreConfigurationVersion({
        ...shared,
        configurationReference: id(20),
        configurationVersion: 1,
        lifecycle: "Published",
        enabledServiceModes: ["DineIn"],
        weeklySchedule: week(["DineIn"]),
        effectiveFrom: "2026-10-01T04:00:00.000Z",
        supersedesConfigurationReference: null,
        reasonCode: "STORE_SETUP_MATERIALIZATION",
        approvedByReference: id(5),
        approvalEvidenceReference: id(21),
        publicationReference: id(22),
        liveGateEvidenceReference: id(23),
        createdAt: "2026-10-01T04:00:00.000Z",
        updatedAt: "2026-10-01T04:00:00.000Z",
      });
      // The setup adds pickup.
      const setup = createStoreConfigurationVersion({
        ...shared,
        configurationReference: id(30),
        configurationVersion: 2,
        lifecycle: "Draft",
        enabledServiceModes: ["DineIn", "Pickup"],
        weeklySchedule: week(["DineIn", "Pickup"]),
        effectiveFrom: at,
        supersedesConfigurationReference: id(20),
        reasonCode: "STORE_SETUP_MATERIALIZATION",
        approvedByReference: null,
        approvalEvidenceReference: null,
        publicationReference: null,
        liveGateEvidenceReference: null,
        createdAt: at,
        updatedAt: at,
      });
      const operating = {
        tenantReference: ownerScope.tenantReference,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        requiredLiveGateRequirementCodes: [],
      };
      const storePhoneCheck = () =>
        transactions().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [ownerScope.tenantReference, ownerScope.brandReference, ownerScope.storeReference],
          );
          const checks = await storeConfigurationPublicationChecks(operating, tx, {
            configuration: setup,
            published: { configuration: live },
            at: world.now(),
            authorize: async () => true,
          });
          return checks.checks.find((check) => check.code === "StorePhone").outcome;
        });
      assert.equal(await storePhoneCheck(), "Fail");
      const published = await createMerchantStorePublicProfile({
        persistence: { ...owner.persistence, now: world.now },
        authentication: owner.authentication,
      })({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        command: {
          expectedVersion: 0,
          operationReference: fresh(),
          details: {
            storeDisplayNames: { "en-CA": "Synthetic Store" },
            address: {
              addressLines: ["1 Synthetic Street"],
              locality: "Ottawa",
              regionCode: "ON",
              postalCode: "K1A 0A1",
            },
            businessPhone: "613-555-0142",
          },
        },
      });
      assert.equal(published.current.businessPhone, "+16135550142");
      assert.equal(await storePhoneCheck(), "Pass");
    },
  );
});
