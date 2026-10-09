import { createHttpReceiptClient } from "./receipt/receipt-client.js";
import { createReceiptController } from "./receipt/receipt-controller.js";
import type { DiningAdmissionUi } from "./dining/DiningAdmissionPanel.js";
import { Route, Routes, useParams } from "react-router";
import { useCallback, useMemo, useState } from "react";
import { CartPage } from "./cart/CartPage.js";
import { CheckoutPage } from "./checkout/CheckoutPage.js";
import { CustomerShell } from "./CustomerShell.js";
import { EntryContextPage } from "./entry/EntryContextPage.js";
import type { CustomerEntryClient } from "./entry/types.js";
import {
  MenuBrowsePage,
  MenuSearchPage,
  SellableDetailPage,
  type CartCountLoader,
} from "./menu/MenuPage.js";
import type { MenuJourneyContext } from "./menu/types.js";
import { PaymentPage } from "./payment/PaymentPage.js";
import { OrderStatusPage } from "./order-status/OrderStatusPage.js";
import { createOrderStatusController } from "./order-status/order-status-controller.js";
import { createHttpOrderStatusClient } from "./order-status/order-status-client.js";
import { ConnectivityBanner } from "./connectivity/ConnectivityBanner.js";
import { PwaUpdateBanner } from "./pwa/PwaUpdateBanner.js";
import { ReceiptPage } from "./receipt/ReceiptPage.js";
import { DeliveryStatusPage } from "./delivery-status/DeliveryStatusPage.js";
import { DiningSessionPage } from "./dining/DiningSessionPage.js";
import type { CustomerDemoDependencies } from "./customer-demo.js";
import type { CustomerStoreContext } from "./journey/CustomerPage.js";

function useDemoForOrderRoute(
  demo: CustomerDemoDependencies | undefined,
): CustomerDemoDependencies | undefined {
  const { orderReference = "" } = useParams();
  return demo?.orderReference === orderReference ? demo : undefined;
}

function HttpOrderStatusRoute({
  orderReference,
  store,
}: {
  readonly orderReference: string;
  readonly store: CustomerStoreContext | undefined;
}) {
  const [controller] = useState(() =>
    createOrderStatusController(orderReference, createHttpOrderStatusClient()),
  );
  return <OrderStatusPage controller={controller} store={store} />;
}

function CustomerOrderStatusRoute({
  demo,
  store,
}: {
  readonly demo: CustomerDemoDependencies | undefined;
  readonly store: CustomerStoreContext | undefined;
}) {
  const { orderReference = "" } = useParams();
  const matchedDemo = useDemoForOrderRoute(demo);
  return matchedDemo ? (
    <OrderStatusPage
      key={orderReference}
      controller={matchedDemo.orderStatusController}
      store={store}
    />
  ) : (
    <HttpOrderStatusRoute key={orderReference} orderReference={orderReference} store={store} />
  );
}

function CustomerDeliveryStatusRoute({
  demo,
  store,
}: {
  readonly demo: CustomerDemoDependencies | undefined;
  readonly store: CustomerStoreContext | undefined;
}) {
  const matchedDemo = useDemoForOrderRoute(demo);
  return (
    <DeliveryStatusPage
      store={store}
      {...(matchedDemo ? { client: matchedDemo.deliveryClient } : {})}
    />
  );
}

function HttpReceiptRoute({
  orderReference,
  store,
}: {
  readonly orderReference: string;
  readonly store: CustomerStoreContext | undefined;
}) {
  const [controller] = useState(() =>
    createReceiptController(orderReference, createHttpReceiptClient()),
  );
  return <ReceiptPage controller={controller} store={store} />;
}
function CustomerReceiptRoute({
  demo,
  store,
}: {
  readonly demo: CustomerDemoDependencies | undefined;
  readonly store: CustomerStoreContext | undefined;
}) {
  const { orderReference = "" } = useParams();
  const matchedDemo = useDemoForOrderRoute(demo);
  return matchedDemo ? (
    <ReceiptPage key={orderReference} controller={matchedDemo.receiptController} store={store} />
  ) : (
    <HttpReceiptRoute key={orderReference} orderReference={orderReference} store={store} />
  );
}

export function App({
  checkoutNow,
  diningAdmission,
  entryClient,
  initialMenuContext,
  demo,
}: Readonly<{
  checkoutNow?: () => number;
  diningAdmission?: DiningAdmissionUi | undefined;
  entryClient?: CustomerEntryClient | undefined;
  initialMenuContext?: MenuJourneyContext | undefined;
  demo?: CustomerDemoDependencies | undefined;
}>) {
  const [menuContext, setMenuContext] = useState<MenuJourneyContext | undefined>(
    initialMenuContext ?? demo?.menuContext,
  );
  const store: CustomerStoreContext | undefined = menuContext
    ? {
        storeName: menuContext.storeDisplayName,
        brandName: menuContext.brandDisplayName,
        serviceMode: menuContext.channel,
      }
    : undefined;
  // A preview never calls the Store; its cart count comes from the injected controller.
  const demoCartCount = useMemo<CartCountLoader | undefined>(
    () =>
      demo
        ? async () => {
            const state = demo.cartController.getState();
            return "cart" in state && state.cart !== null
              ? state.cart.cart.items.reduce((total, item) => total + item.quantity, 0)
              : 0;
          }
        : undefined,
    [demo],
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
              cartCount={demoCartCount}
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
              cartCount={demoCartCount}
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
        <Route path="/dine-in/session" element={<DiningSessionPage store={store} />} />
        <Route
          path="/cart"
          element={
            <CartPage store={store} {...(demo ? { controller: demo.cartController } : {})} />
          }
        />
        <Route
          path="/checkout"
          element={
            <CheckoutPage
              store={store}
              {...(checkoutNow === undefined ? {} : { now: checkoutNow })}
              {...(demo ? { controller: demo.checkoutController, now: demo.now } : {})}
            />
          }
        />
        <Route path="/checkout/payment" element={<PaymentPage mode="handoff" store={store} />} />
        <Route path="/checkout/result" element={<PaymentPage mode="result" store={store} />} />
        <Route
          path="/orders/:orderReference"
          element={<CustomerOrderStatusRoute demo={demo} store={store} />}
        />
        <Route
          path="/orders/:orderReference/delivery"
          element={<CustomerDeliveryStatusRoute demo={demo} store={store} />}
        />
        <Route
          path="/orders/:orderReference/receipt"
          element={<CustomerReceiptRoute demo={demo} store={store} />}
        />
        <Route path="*" element={<CustomerShell />} />
      </Routes>
    </>
  );
}
