import { LanguageSwitch, t, useLanguage } from "../i18n/i18n.js";
import { AppFrame } from "@bop-rms/ui";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";

export type CustomerJourneyStep =
  "entry" | "menu" | "cart" | "checkout" | "payment" | "order" | "receipt" | "table" | "other";

export interface CustomerStoreContext {
  readonly storeName: string;
  readonly brandName?: string | undefined;
  readonly serviceMode?: "DineIn" | "Pickup" | undefined;
}

export const serviceModeLabel = (mode: "DineIn" | "Pickup" | undefined): string =>
  mode === "DineIn" ? t("Dine in") : mode === "Pickup" ? t("Pickup") : "";

/** One frame for every customer page: the Store as the title, one journey navigation, one main landmark. */
export function CustomerPage({
  step,
  store,
  orderReference,
  className,
  fallbackTitle,
  children,
}: {
  readonly step: CustomerJourneyStep;
  readonly store?: CustomerStoreContext | undefined;
  /** When known, the journey offers a direct way back to the live order. */
  readonly orderReference?: string | undefined;
  readonly className?: string | undefined;
  /** Title while no Store is known yet (defaults to "Order"). */
  readonly fallbackTitle?: string | undefined;
  readonly children: ReactNode;
}) {
  const { language } = useLanguage();
  const mode = serviceModeLabel(store?.serviceMode);
  // The browser tab and the installed app carry the Store's name, not the product's.
  useEffect(() => {
    document.title = store
      ? t("{storeName} · Order", { storeName: store.storeName })
      : t("BOP Order");
  }, [store, language]);
  const description = store
    ? [store.brandName, mode].filter((part) => part !== undefined && part !== "").join(" · ")
    : t("Scan the location QR code to begin");
  const links: readonly { step: CustomerJourneyStep; label: string; href: string }[] = [
    { step: "menu", label: t("Menu"), href: "/menu" },
    { step: "cart", label: t("Cart"), href: "/cart" },
    ...(orderReference === undefined
      ? []
      : [{ step: "order" as const, label: t("Order"), href: `/orders/${orderReference}` }]),
    // WP-2423 Q8: a dine-in guest can always see what the whole table has ordered.
    ...(store?.serviceMode === "DineIn" || step === "table"
      ? [{ step: "table" as const, label: t("Your table"), href: "/dine-in/session" }]
      : []),
  ];
  return (
    <AppFrame
      className={`customer-page customer-page--${step}${className ? ` ${className}` : ""}`}
      title={store?.storeName ?? fallbackTitle ?? t("Order")}
      description={description}
      navigationLabel={t("Customer journey")}
      navigation={[
        ...links.map((link) =>
          link.step === step ? (
            <span key={link.step} aria-current="page">
              {link.label}
            </span>
          ) : (
            <Link key={link.step} to={link.href}>
              {link.label}
            </Link>
          ),
        ),
        // Owner 2026-10-23: English / Simplified Chinese on every customer page.
        <LanguageSwitch key="language" />,
      ]}
    >
      {children}
    </AppFrame>
  );
}

/** Page-level heading block under the frame title. */
export function PageHeading({
  eyebrow,
  title,
  children,
  id = "page-heading",
}: {
  readonly eyebrow?: string | undefined;
  readonly title: string;
  readonly children?: ReactNode;
  readonly id?: string;
}) {
  return (
    <header className="customer-heading">
      {eyebrow ? <p className="bop-eyebrow">{eyebrow}</p> : null}
      <h2 id={id}>{title}</h2>
      {children}
    </header>
  );
}
