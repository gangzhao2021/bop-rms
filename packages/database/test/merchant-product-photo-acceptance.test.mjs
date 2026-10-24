import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import {
  createLocalFilesystemMediaImageObjectStore,
  createProductImageService,
} from "../../bop/media/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { productApiGrants, productPhotoApiGrants } from "../test-support/merchant-api-grants.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";

const { Client } = pg;
// Test image generator only: sharp is a dependency of @bop/media, not of this package.
const sharp = createRequire(new URL("../../bop/media/package.json", import.meta.url))("sharp");
const id = (n) => "01909a1b-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 menu descriptions and photos: staff upload a product photo (Media removes camera and
 * location data and stores the sizes), then save it with alt text and a description in the product
 * draft, through the API composition under the pilot API role's RLS (NOBYPASSRLS). Synthetic images.
 */
it("uploads a product photo, saves it with a description and refuses unsafe photos", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_product_photo" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_product_photo_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      reader = id(5),
      outsider = id(6),
      taxClass = id(100),
      otherTaxClass = id(101);
    void otherTaxClass;
    let second = 0;
    const now = () => {
      second += 1;
      return new Date(Date.UTC(2026, 9, 7, 12, 0, second)).toISOString();
    };
    let operation = 0x7000;
    const op = () => "019a0000-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    const root = await mkdtemp(join(tmpdir(), "bop-product-photo-"));
    const directory = join(root, "media", "product-images");
    try {
      // TEST-ONLY tax configuration: one Published version covering one tax class (13 %).
      const at = "2026-09-20T00:00:00.000Z";
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,$4,$5,$4)",
        [id(200), brandReference, storeReference, at, owner],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
         VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,$7,NULL,'America/Toronto',$8,$9,$10,'2027-01-01T00:00:00.000Z',$11,$12,$13,$5,'2027-01-01T00:00:00.000Z',$7)`,
        [
          id(201),
          id(200),
          brandReference,
          storeReference,
          "sha256:" + "a".repeat(64),
          id(202),
          at,
          id(203),
          id(204),
          id(205),
          id(206),
          id(207),
          id(208),
        ],
      );
      for (const [n, orderType] of [
        [210, "Pickup"],
        [211, "DineIn"],
      ])
        await admin.query(
          "INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,$7,'Sellable','TEST_TAX','Taxable',0.13,'Exclusive','HalfUp',1,false,NULL,'TEST_TAX_LINE')",
          [id(n), id(201), id(200), brandReference, storeReference, taxClass, orderType],
        );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
        [id(201), id(200)],
      );

      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [...productApiGrants, ...productPhotoApiGrants])
        await admin.query(sql.replaceAll("ROLE_", role));

      const persistence = {
        now,
        transactions: {
          async run(work) {
            await admin.query("BEGIN");
            try {
              await admin.query("SET LOCAL ROLE " + role);
              await admin.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
              const value = await work(admin);
              await admin.query("COMMIT");
              return value;
            } catch (error) {
              await admin.query("ROLLBACK");
              throw error;
            }
          },
        },
      };
      // Brand grants per Actor: the owner holds every Product action; the reader may only read.
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: {
          [owner]: [
            "catalog.product.read",
            "catalog.product.create",
            "catalog.product.update",
            "catalog.product.manage",
            "catalog.product.publish",
            "catalog.sku.create",
            "catalog.sku.activate",
          ],
          [reader]: ["catalog.product.read"],
          [outsider]: [],
        },
      });
      const products = createMerchantProducts({
        persistence,
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        references: { next: op },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
        images: createProductImageService({
          objectStore: createLocalFilesystemMediaImageObjectStore({ directory }),
        }),
      });
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const command = (body) => products.command({ ...session, body });
      const rejects = async (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));
      const create = async (code, name) =>
        (
          await command({
            action: "Create",
            operationReference: op(),
            internalCode: code,
            productType: "NonAlcoholicBeverage",
            name,
            taxClassificationReference: taxClass,
            sizes: [{ skuReference: null, skuCode: code + "-S", name: "Small" }],
          })
        ).product;
      const latte = await create("LATTE", "Latte");
      const mocha = await create("MOCHA", "Mocha");
      // A new product has no description or photo.
      assert.deepEqual(latte.presentation, { description: "", photo: null });

      // A phone photo with camera and location data (synthetic).
      const jpeg = await sharp({
        create: { width: 1200, height: 900, channels: 3, background: { r: 120, g: 80, b: 40 } },
      })
        .withExif({
          IFD0: { Make: "SyntheticCam", Model: "TEST ONLY" },
          IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 39/1 0/1" },
        })
        .jpeg()
        .toBuffer();
      assert.ok((await sharp(jpeg).metadata()).exif, "fixture carries EXIF");
      const upload = (
        productReference,
        bytes,
        contentType = "image/jpeg",
        operationReference = op(),
      ) =>
        products.uploadPhoto({
          ...session,
          productReference,
          operationReference,
          contentType,
          bytes: new Uint8Array(bytes),
        });
      const uploadOperation = op();
      const uploaded = await upload(latte.productReference, jpeg, "image/jpeg", uploadOperation);
      assert.equal(uploaded.status, "Recorded");
      assert.match(uploaded.photo.previewUrl, /^\/media\/images\/[0-9a-f]{64}\.jpg$/u);
      assert.equal(uploaded.photo.width, 1280);
      assert.equal(uploaded.photo.height, 960);
      // A retry of the same upload returns the same image.
      assert.deepEqual(
        await upload(latte.productReference, jpeg, "image/jpeg", uploadOperation),
        uploaded,
      );
      const files = (await readdir(directory)).sort();
      assert.equal(files.length, 6);
      for (const file of files) {
        const metadata = await sharp(join(directory, file)).metadata();
        assert.equal(metadata.exif, undefined, file + " keeps no camera or location data");
      }
      const rows = (
        await admin.query(
          "SELECT brand_id,product_id,data_classification,storage_profile FROM bop_media.product_image",
        )
      ).rows;
      assert.deepEqual(rows, [
        {
          brand_id: brandReference,
          product_id: latte.productReference,
          data_classification: "Public",
          storage_profile: "PilotLocalFilesystemV1",
        },
      ]);

      // Save the photo with alt text and a description; the product shows them back.
      const save = (product, presentation) =>
        command({
          action: "SaveDraft",
          operationReference: op(),
          productReference: product.productReference,
          expectedAggregateVersion: product.aggregateVersion,
          name: product.name,
          taxClassificationReference: product.taxClassificationReference,
          sizes: product.sizes.map((size) => ({
            skuReference: size.skuReference,
            skuCode: size.skuCode,
            name: size.name,
          })),
          presentation,
        });
      const saved = await save(latte, {
        description: "Double espresso with   steamed milk.",
        photo: { imageReference: uploaded.photo.imageReference, altText: "Latte in a white cup" },
      });
      assert.deepEqual(saved.product.presentation, {
        description: "Double espresso with steamed milk.",
        photo: {
          imageReference: uploaded.photo.imageReference,
          altText: "Latte in a white cup",
          width: 1280,
          height: 960,
          previewUrl: uploaded.photo.previewUrl,
        },
      });
      const detail = await products.query({ ...session, productReference: latte.productReference });
      assert.deepEqual(detail.product.presentation, saved.product.presentation);
      const stored = (
        await admin.query(
          "SELECT customer_presentation_json p FROM rms_catalog.product_version WHERE product_id=$1",
          [latte.productReference],
        )
      ).rows[0].p;
      assert.deepEqual(stored, {
        localizedDescriptions: { "en-CA": "Double espresso with steamed milk." },
        photo: {
          imageReference: uploaded.photo.imageReference,
          localizedAltText: { "en-CA": "Latte in a white cup" },
        },
      });
      // A save without the presentation keeps it.
      const renamed = await command({
        action: "SaveDraft",
        operationReference: op(),
        productReference: latte.productReference,
        expectedAggregateVersion: saved.product.aggregateVersion,
        name: "Caffe Latte",
        taxClassificationReference: taxClass,
        sizes: saved.product.sizes.map((size) => ({
          skuReference: size.skuReference,
          skuCode: size.skuCode,
          name: size.name,
        })),
      });
      assert.deepEqual(renamed.product.presentation, saved.product.presentation);

      // Refusals: another product's photo, a missing image, markup in the description, no alt text.
      await rejects(
        save(mocha, {
          description: "",
          photo: { imageReference: uploaded.photo.imageReference, altText: "Latte" },
        }),
        "Invalid",
      );
      await rejects(
        save(mocha, { description: "", photo: { imageReference: id(999), altText: "Mocha" } }),
        "Invalid",
      );
      await rejects(save(mocha, { description: "<b>Rich</b>", photo: null }), "Invalid");
      await rejects(
        save(mocha, {
          description: "",
          photo: { imageReference: uploaded.photo.imageReference, altText: "" },
        }),
        "Invalid",
      );
      // Unsafe or unusable files.
      const png = await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer();
      await rejects(upload(mocha.productReference, png, "image/jpeg"), "PhotoUnreadable");
      await rejects(
        upload(mocha.productReference, Buffer.from("<svg onload=alert(1)>"), "image/svg+xml"),
        "PhotoTypeUnsupported",
      );
      const tiny = await sharp({
        create: { width: 300, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .jpeg()
        .toBuffer();
      await rejects(upload(mocha.productReference, tiny), "PhotoTooSmall");
      await rejects(upload(id(998), jpeg), "NotFound");
      assert.equal((await readdir(directory)).length, 6);

      // Removing the photo and description is recorded; readers and outsiders cannot upload.
      const cleared = await save(renamed.product, { description: "", photo: null });
      assert.deepEqual(cleared.product.presentation, { description: "", photo: null });
      scope.as(reader);
      await rejects(upload(latte.productReference, jpeg), "PermissionDenied");
      scope.as(outsider);
      await rejects(upload(latte.productReference, jpeg), "PermissionDenied");
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM bop_media.product_image")).rows[0].n,
        1,
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
