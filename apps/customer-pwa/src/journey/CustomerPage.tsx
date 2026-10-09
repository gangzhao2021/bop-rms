import { AppFrame } from "@bop-rms/ui";
import type { ReactNode } from "react";
import { Link } from "react-router";

export type CustomerJourneyStep =
  "entry" | "menu" | "cart" | "checkout" | "payment" | "order" | "receipt" | "other";

export interface CustomerStoreContext {
  readonly storeName: string;
  readonly brandName?: string | undefined;
  readonly serviceMode?: "DineIn" | "Pickup" | undefined;
}

export const serviceModeLabel = (mode: "DineIn" | "Pickup" | undefined): string =>
  mode === "DineIn" ? "Dine in" : mode === "Pickup" ? "Pickup" : "";

/** One frame for every customer page: the Store as the title, one journey navigation, one main landmark. */
export function CustomerPage({
  step,
  store,
  orderReference,
  className,
  fallbackTitle = "Order",
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
  const mode = serviceModeLabel(store?.serviceMode);
  const description = store
    ? [store.brandName, mode].filter((part) => part !== undefined && part !== "").join(" · ")
    : "Scan the location QR code to begin";
  const links: readonly { step: CustomerJourneyStep; label: string; href: string }[] = [
    { step: "menu", label: "Menu", href: "/menu" },
    { step: "cart", label: "Cart", href: "/cart" },
    ...(orderReference === undefined
      ? []
      : [{ step: "order" as const, label: "Order", href: `/orders/${orderReference}` }]),
  ];
  return (
    <AppFrame
      className={`customer-page customer-page--${step}${className ? ` ${className}` : ""}`}
      title={store?.storeName ?? fallbackTitle}
      description={description}
      navigationLabel="Customer journey"
      navigation={links.map((link) =>
        link.step === step ? (
          <span key={link.step} aria-current="page">
            {link.label}
          </span>
        ) : (
          <Link key={link.step} to={link.href}>
            {link.label}
          </Link>
        ),
      )}
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
