import assert from "node:assert/strict";
import { createPersistentMerchantBffService } from "../../../apps/api/src/persistent-merchant-bff.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

/** Synthetic configuration with real Identity, IAM and FeatureControl owner reads. */
export async function verifyProductListNavigationRuntime({
  admin,
  role,
  options,
  cookie,
  clock,
  targetReference,
  readGrant,
  login,
}) {
  const previous = options.catalogProductNavigation,
    actualNow = options.now,
    actualActor = options.currentActor,
    actualTarget = options.targetScope,
    hasProduct = (value) =>
      value.workspace.navigation.some((item) => item.screenId === "CAT-PRODUCT-LIST"),
    service = () => createPersistentMerchantBffService(options);
  await admin.query("GRANT USAGE ON SCHEMA bop_feature_control TO " + role);
  await admin.query(
    "GRANT SELECT ON bop_feature_control.control_version,bop_feature_control.control_dependency TO " +
      role,
  );
  const featureVersion = (version, value) =>
    admin.query(
      "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,NULL,'catalog.product.list',$3,'Synthetic Product navigation',$4,'PRODUCT_CAPABILITY','BrandOverride','Disabled',$5,'Published',false,$6,NULL,$7,NULL,$4,$8,$9,$10,$6,'ConfigurationMetadata')",
      [
        f.uuid("9200"),
        f.BRAND,
        version,
        f.ACTOR,
        value,
        clock.from,
        clock.until,
        f.uuid("9201"),
        f.uuid(String(9210 + version)),
        f.uuid(String(9220 + version)),
      ],
    );
  try {
    options.catalogProductNavigation = { currentRuntime: true };
    assert.equal(
      hasProduct(await service().bootstrap(cookie)),
      false,
      "no actual definition hides navigation",
    );
    await featureVersion(1, "Enabled");
    assert.equal(hasProduct(await service().bootstrap(cookie)), true);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [readGrant],
    );
    assert.equal(
      hasProduct(await service().bootstrap(cookie)),
      false,
      "missing current Brand field grant hides navigation",
    );
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
      [readGrant],
    );
    assert.equal(hasProduct(await service().bootstrap(cookie)), true);
    await featureVersion(2, "Disabled");
    const disabled = await service().bootstrap(cookie);
    assert.equal(hasProduct(disabled), false);
    assert.equal(disabled.workspace.storeStatus, "Open");
    await featureVersion(3, "Enabled");
    // Login has an actual newly-created session but no browser cookie in its callback.
    const loggedIn = await login(service()),
      issued = loggedIn.cookies.find((entry) => !entry.clear);
    assert(issued);
    const beforeSwitch = await service().bootstrap(issued.value);
    assert.equal(hasProduct(beforeSwitch), true);
    const switched = await service().switchStore({
      sessionCookie: issued.value,
      csrf: beforeSwitch.csrf,
      targetStoreReference: targetReference,
    });
    assert.equal(hasProduct(switched), true);
    assert.equal(switched.workspace.selectedScope.storeReference, targetReference);
    assert.equal(hasProduct(await service().bootstrap(switched.cookie.value)), true);
    await service().logout(switched.cookie.value);

    // The second Store is resolved after Product navigation was admitted.
    let afterNavigation = false;
    options.targetScope = async (...args) => {
      const value = await actualTarget(...args);
      afterNavigation = true;
      return value;
    };
    options.now = () =>
      afterNavigation ? new Date(Date.parse(actualNow()) + 6000).toISOString() : actualNow();
    await assert.rejects(service().bootstrap(cookie));
    options.now = actualNow;
    afterNavigation = false;
    options.currentActor = async (...args) => (afterNavigation ? null : actualActor(...args));
    await assert.rejects(service().bootstrap(cookie));
    options.currentActor = actualActor;
    options.targetScope = actualTarget;
    assert.equal(hasProduct(await service().bootstrap(cookie)), true);
  } finally {
    options.catalogProductNavigation = previous;
    options.now = actualNow;
    options.currentActor = actualActor;
    options.targetScope = actualTarget;
  }
}
