import type { DiningAdmissionUi } from "./dining/DiningAdmissionPanel.js";
import { Route, Routes, useParams } from "react-router";
import { useCallback, useState } from "react";
import { CartPage } from "./cart/CartPage.js";
import { CheckoutPage } from "./checkout/CheckoutPage.js";
import { CustomerShell } from "./CustomerShell.js";
import { EntryContextPage } from "./entry/EntryContextPage.js";
import type { CustomerEntryClient } from "./entry/types.js";
import { MenuBrowsePage, MenuSearchPage, SellableDetailPage } from "./menu/MenuPage.js";
import type { MenuJourneyContext } from "./menu/types.js";
import { PaymentPage } from "./payment/PaymentPage.js";
import { OrderStatusPage } from "./order-status/OrderStatusPage.js";
import { ConnectivityBanner } from "./connectivity/ConnectivityBanner.js";
import { PwaUpdateBanner } from "./pwa/PwaUpdateBanner.js";
import { ReceiptPage } from "./receipt/ReceiptPage.js";
import { DeliveryStatusPage } from "./delivery-status/DeliveryStatusPage.js";
import type { CustomerDemoDependencies } from "./customer-demo.js";

function useDemoForOrderRoute(
  demo: CustomerDemoDependencies | undefined,
): CustomerDemoDependencies | undefined {
  const { orderReference = "" } = useParams();
  return demo?.orderReference === orderReference ? demo : undefined;
}

function CustomerOrderStatusRoute({
  demo,
}: {
  readonly demo: CustomerDemoDependencies | undefined;
}) {
  const matchedDemo = useDemoForOrderRoute(demo);
  return (
    <OrderStatusPage {...(matchedDemo ? { controller: matchedDemo.orderStatusController } : {})} />
  );
}

function CustomerDeliveryStatusRoute({
  demo,
}: {
  readonly demo: CustomerDemoDependencies | undefined;
}) {
  const matchedDemo = useDemoForOrderRoute(demo);
  return <DeliveryStatusPage {...(matchedDemo ? { client: matchedDemo.deliveryClient } : {})} />;
}

function CustomerReceiptRoute({ demo }: { readonly demo: CustomerDemoDependencies | undefined }) {
  const matchedDemo = useDemoForOrderRoute(demo);
  return <ReceiptPage {...(matchedDemo ? { controller: matchedDemo.receiptController } : {})} />;
}

export function App({
  diningAdmission,
  entryClient,
  initialMenuContext,
  demo,
}: Readonly<{
  diningAdmission?: DiningAdmissionUi | undefined;
  entryClient?: CustomerEntryClient | undefined;
  initialMenuContext?: MenuJourneyContext | undefined;
  demo?: CustomerDemoDependencies | undefined;
}>) {
  const [menuContext, setMenuContext] = useState<MenuJourneyContext | undefined>(
    initialMenuContext ?? demo?.menuContext,
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
    <>
      <ConnectivityBanner />
      <PwaUpdateBanner />
      {demo ? <demo.Notice /> : null}
      <Routes>
        <Route
          path="/"
          element={
            <EntryContextPage
              diningAdmission={diningAdmission}
              client={entryClient ?? demo?.entryClient}
              onEstablished={establishMenuContext}
            />
          }
        />
        <Route
          path="/menu"
          element={
            <MenuBrowsePage
              context={menuContext}
              client={demo?.menuClient}
              readOnlyNotice={demo?.menuReadOnlyNotice}
            />
          }
        />
        <Route
          path="/menu/search"
          element={
            <MenuSearchPage
              context={menuContext}
              client={demo?.menuClient}
              readOnlyNotice={demo?.menuReadOnlyNotice}
            />
          }
        />
        <Route
          path="/menu/items/:sellableId"
          element={
            <SellableDetailPage
              context={menuContext}
              client={demo?.menuClient}
              readOnlyNotice={demo?.menuReadOnlyNotice}
            />
          }
        />
        <Route
          path="/cart"
          element={<CartPage {...(demo ? { controller: demo.cartController } : {})} />}
        />
        <Route
          path="/checkout"
          element={
            <CheckoutPage
              {...(demo ? { controller: demo.checkoutController, now: demo.now } : {})}
            />
          }
        />
        <Route path="/checkout/payment" element={<PaymentPage mode="handoff" />} />
        <Route path="/checkout/result" element={<PaymentPage mode="result" />} />
        <Route path="/orders/:orderReference" element={<CustomerOrderStatusRoute demo={demo} />} />
        <Route
          path="/orders/:orderReference/delivery"
          element={<CustomerDeliveryStatusRoute demo={demo} />}
        />
        <Route
          path="/orders/:orderReference/receipt"
          element={<CustomerReceiptRoute demo={demo} />}
        />
        <Route path="*" element={<CustomerShell />} />
      </Routes>
    </>
  );
}
