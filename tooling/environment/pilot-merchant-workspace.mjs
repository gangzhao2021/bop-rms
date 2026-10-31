/**
 * WP-2423: the staff workspace the pilot lists (navigation candidates; the BFF keeps those the
 * person may use). DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (v15 2026-10-31): always for the Store
 * the session is bound to — a Store switch is answered by the composition of the Store left, so
 * nothing here may be that composition's own Store.
 */
export function createPilotWorkspaceListing({ served, optionSets = () => false, tableQr = false }) {
  return function listed({ context }) {
    // The Store the session is bound to, never the composition's own (v15 2026-10-31: a switch is
    // answered by the Store left, whose workspace then named that Store and was refused).
    const here = String(context.store.storeReference);
    return {
      screenId: "HOME-OVERVIEW",
      selectedScope: {
        brandLabel: context.brand.displayName,
        storeLabel: context.store.displayName,
        storeReference: here,
        timeZone: context.store.timeZone,
      },
      // Candidates only: the BFF lists those the person may use, with each Store's own name.
      authorizedStores: served.map((store) => ({
        brandLabel: context.brand.displayName,
        storeLabel: context.store.displayName,
        storeReference: store.storeReference,
      })),
      // The Store-local calendar date (a UTC date is already tomorrow in Toronto after 20:00).
      businessDate: new Intl.DateTimeFormat("en-CA", {
        timeZone: context.store.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(context.resolvedAt)),
      storeStatus: "Unavailable",
      freshness: "Stale",
      dashboardAvailability: "UnavailableUntilWP1905",
      navigation: [
        {
          screenId: "STORE-SETUP",
          label: "Store setup",
          href: "/app/organization/stores/" + here + "/setup",
          permission: "organization.manage",
        },
        // DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: the Stores this person works in (switch, open).
        {
          screenId: "ORG-STORE-LIST",
          label: "Stores",
          href: "/app/organization/stores",
          permission: "organization.store.read",
        },
        // WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the modules the Store uses.
        {
          screenId: "STORE-CAPABILITY",
          label: "Store features",
          href: "/app/organization/stores/" + here + "/capabilities",
          permission: "organization.manage",
        },
        // WP-2423 / DEC-CAT-PRODUCT-ADMIN: Brand Products (merchant-products).
        {
          screenId: "CAT-PRODUCT-LIST",
          label: "Products",
          href: "/app/commerce/products",
          permission: "catalog.manage",
        },
        ...(optionSets()
          ? [
              {
                screenId: "CAT-OPTIONSET-LIST",
                label: "Option sets",
                href: "/app/commerce/option-sets",
                permission: "catalog.manage",
              },
            ]
          : []),
        {
          screenId: "OPS-ORDER-QUEUE",
          label: "Orders",
          href: "/operations/orders",
          permission: "ordering.operate",
        },
        // WP-2423 Q7: a pickup order taken at the counter, paid on the Store's card machine.
        {
          screenId: "OPS-ORDER-ENTRY",
          label: "Counter order",
          href: "/operations/order-entry",
          permission: "ordering.order.create_staff",
        },
        {
          screenId: "KIT-KITCHEN-QUEUE",
          label: "Kitchen",
          href: "/operations/kitchen",
          permission: "kitchen.operate",
        },
        {
          screenId: "FUL-PICKUP-QUEUE",
          label: "Pickup",
          href: "/operations/pickup",
          permission: "fulfillment.operate",
        },
        // WP-2423 Q8: dine-in tables — start a session, give the table its join code, hand over.
        {
          screenId: "DIN-FLOOR-BOARD",
          label: "Tables",
          href: "/operations/dining",
          permission: "dining.operate",
        },
        // WP-2423 Q11: print, replace and turn off table QR codes (Store Manager, Owner).
        ...(!tableQr
          ? []
          : [
              {
                screenId: "DIN-TABLE-LIST",
                label: "Table QR codes",
                href: "/app/operations/tables",
                permission: "dining.table.qr.manage",
              },
            ]),
        // WP-2423 P1: day-end settlement (Section 88 PAY-RECONCILIATION) under its own read
        // permission (catalog v17): Owner and Store Manager.
        {
          screenId: "PAY-RECONCILIATION",
          label: "Settlement",
          href: "/app/operations/payment-reconciliation",
          permission: "payment.settlement.read",
        },
        // v15 finding: open exceptions and payment differences (Owner, Store Manager); the store
        // system alerts send staff here, so the page must be reachable from the navigation.
        {
          screenId: "OPS-ORDER-EXCEPTION",
          label: "Exceptions",
          href: "/operations/order-exceptions",
          permission: "operations.order-exception.manage",
        },
        // WP-2423 Q14: sales, item, hourly and tip reports with CSV export (Owner, Store Manager).
        {
          screenId: "RPT-OPS-DASHBOARD",
          label: "Reports",
          href: "/app/reports/operations",
          permission: "reporting.sales.read",
        },
        {
          screenId: "INV-ITEM-LIST",
          label: "Inventory items",
          href: "/app/supply/items",
          permission: "inventory.item.read",
        },
        {
          screenId: "INV-LOCATION-LIST",
          label: "Stock locations",
          href: "/app/supply/locations",
          permission: "inventory.location.read",
        },
        {
          screenId: "INV-RECEIPT-LIST",
          label: "Receiving",
          href: "/operations/receiving",
          permission: "inventory.receipt.read",
        },
        {
          screenId: "RECIPE-LIST",
          label: "Recipes",
          href: "/app/commerce/recipes",
          permission: "recipe.read",
        },
        {
          screenId: "RECIPE-OPTION-LIST",
          label: "Option recipes",
          href: "/app/commerce/option-recipes",
          permission: "recipe.read",
        },
        {
          screenId: "CAT-MENU-LIST",
          label: "Menus",
          href: "/app/commerce/menus",
          permission: "catalog.menu.read",
        },
        {
          screenId: "CAT-OPTIONSET-LIST",
          label: "Options",
          href: "/app/commerce/option-sets",
          permission: "catalog.option_set.read",
        },
        // WP-2423 Q5: refunds awaiting an Owner approval (Section 88 APPROVAL-INBOX).
        {
          screenId: "APPROVAL-INBOX",
          label: "Approvals",
          href: "/app/approvals",
          permission: "workflow.operate",
        },
        // WP-2423 Q4: busy mode (pause/resume online ordering) and published hours.
        {
          screenId: "STORE-HOURS-SERVICE",
          label: "Hours & ordering",
          href: "/app/organization/stores/" + here + "/service",
          permission: "store.service.read",
        },
        {
          screenId: "CAT-AVAILABILITY",
          label: "Item availability",
          href: "/app/commerce/availability",
          permission: "catalog.sku.read",
        },
        {
          screenId: "PRICE-BOOK-LIST",
          label: "Prices",
          href: "/app/commerce/pricing",
          permission: "pricing.price_book.read",
        },
        {
          screenId: "PRICE-OPTION-LIST",
          label: "Option prices",
          href: "/app/commerce/option-prices",
          permission: "pricing.price_book.read",
        },
        {
          screenId: "TAX-STORE-REVIEW",
          label: "Tax review",
          href: "/app/commerce/tax-review",
          permission: "pricing.tax_config.read",
        },
        // WP-2423 Store setup: the Brand Owner's tax classifications (fees and products name one).
        {
          screenId: "CAT-TAX-CLASSIFICATION-LIST",
          label: "Tax classifications",
          href: "/app/commerce/tax-classifications",
          permission: "catalog.tax-classification.manage",
        },
        {
          screenId: "CMP-ALLERGEN-REVIEW",
          label: "Allergens",
          href: "/app/compliance/allergens",
          permission: "catalog.allergen.read",
        },
        {
          screenId: "INV-COUNT-LIST",
          label: "Stock counts",
          href: "/operations/inventory/counts",
          permission: "inventory.count.read",
        },
        {
          screenId: "INV-WASTE-RECORD",
          label: "Waste",
          href: "/operations/inventory/waste",
          permission: "inventory.waste.record",
        },
        {
          screenId: "INV-OPENING-COUNT",
          label: "Opening count",
          href: "/app/supply/opening-count",
          permission: "inventory.count.read",
        },
        {
          screenId: "IAM-USER-LIST",
          label: "Staff",
          href: "/app/organization/users",
          permission: "organization.staff.read",
        },
        {
          screenId: "IAM-ROLE-LIST",
          label: "Roles",
          href: "/app/organization/roles",
          permission: "identity.role.read",
        },
        // WP-2423 Q18 option A: register shared tablets and reset staff PINs.
        {
          screenId: "IAM-SESSION-LIST",
          label: "Shared tablets & PINs",
          href: "/app/organization/sessions",
          permission: "identity.store_device.manage",
        },
      ],
    };
  };
}
