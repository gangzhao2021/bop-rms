import type { ReactNode } from "react";
export interface StatePanelProps {
  heading: string;
  children: ReactNode;
  tone?: "neutral" | "error" | "offline";
  status?: boolean;
}
export function StatePanel({
  heading,
  children,
  tone = "neutral",
  status = false,
}: StatePanelProps) {
  return (
    <section
      className="bop-state-card"
      data-tone={tone}
      role={status ? "status" : undefined}
      aria-live={status ? "polite" : undefined}
    >
      <h2>{heading}</h2>
      {children}
    </section>
  );
}
