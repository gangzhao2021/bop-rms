import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createUnconfiguredStoreSetupContentV2 } from "./store-setup-client.js";
import { storeSetupMissingItems, storeSetupMissingText } from "./store-setup-missing.js";
import { StoreSetupDraftReview } from "./StoreSetupDraftPage.js";

it("WP-2423 v15: lists every setting that is not set, with the step where it is set", () => {
  const content = {
    ...createUnconfiguredStoreSetupContentV2(),
    // Service charge Off; delivery fee and tip not decided yet (v15: counted but not listed).
    feeContexts: {
      state: "Configured" as const,
      value: [
        { chargeType: "ServiceCharge" as const, state: "Disabled" as const },
        { chargeType: "DeliveryFee" as const, state: "Unconfigured" as const },
        { chargeType: "Tip" as const, state: "Unconfigured" as const },
      ],
    },
  };
  const items = storeSetupMissingItems(content);
  const where = Object.fromEntries(items.map((item) => [item.label, item.where]));
  expect(where["Receipt template"]).toBe("step 5, Tax and payment");
  expect(where["Contact details"]).toBe("step 7, Contacts");
  expect(where["Delivery fee"]).toBe("step 5, Tax and payment");
  expect(where.Tip).toBe("step 5, Tax and payment");
  expect(where).not.toHaveProperty("Service charge");
  expect(where["Tax settings"]).toBe("step 8: Use the live Store’s settings");
  // Review counts exactly the items it lists.
  const html = renderToStaticMarkup(<StoreSetupDraftReview content={content} />);
  expect(html).toContain(`${items.length} settings are not set yet.`);
  for (const item of items) expect(html).toContain(`${item.label}: set it in`);
  expect(storeSetupMissingText(items.slice(0, 2))).toBe(
    `${items[0]?.label} (${items[0]?.where}); ${items[1]?.label} (${items[1]?.where})`,
  );
});
