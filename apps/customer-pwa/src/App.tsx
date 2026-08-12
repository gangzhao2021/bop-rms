import { Route, Routes } from "react-router";
import { useCallback, useState } from "react";
import { CartPage } from "./cart/CartPage.js";
import { CheckoutPage } from "./checkout/CheckoutPage.js";
import { CustomerShell } from "./CustomerShell.js";
import { EntryContextPage } from "./entry/EntryContextPage.js";
import type { CustomerEntryClient } from "./entry/types.js";
import { MenuBrowsePage, MenuSearchPage, SellableDetailPage } from "./menu/MenuPage.js";
import type { MenuJourneyContext } from "./menu/types.js";
import { PaymentPage } from "./payment/PaymentPage.js";

export function App({
  entryClient,
  initialMenuContext,
}: Readonly<{
  entryClient?: CustomerEntryClient | undefined;
  initialMenuContext?: MenuJourneyContext | undefined;
}>) {
  const [menuContext, setMenuContext] = useState<MenuJourneyContext | undefined>(
    initialMenuContext,
  );
  const establishMenuContext = useCallback((context: MenuJourneyContext) => {
    setMenuContext(
      Object.freeze({
        publicStoreReference: context.publicStoreReference,
        channel: context.channel,
        locale: context.locale,
        brandDisplayName: context.brandDisplayName,
        storeDisplayName: context.storeDisplayName,
      }),
    );
  }, []);
  return (
    <Routes>
      <Route
        path="/"
        element={<EntryContextPage client={entryClient} onEstablished={establishMenuContext} />}
      />
      <Route path="/menu" element={<MenuBrowsePage context={menuContext} />} />
      <Route path="/menu/search" element={<MenuSearchPage context={menuContext} />} />
      <Route
        path="/menu/items/:sellableId"
        element={<SellableDetailPage context={menuContext} />}
      />
      <Route path="/cart" element={<CartPage />} />
      <Route path="/checkout" element={<CheckoutPage />} />
      <Route path="/checkout/payment" element={<PaymentPage mode="handoff" />} />
      <Route path="/checkout/result" element={<PaymentPage mode="result" />} />
      <Route path="*" element={<CustomerShell />} />
    </Routes>
  );
}
