export function LocalDemoNotice() {
  return (
    <aside className="local-demo-notice" role="status" aria-label="Local synthetic preview">
      <strong>Local synthetic preview</strong>
      <span>
        Read-only training data. No API, permission, business fact, or publication is implied.
      </span>
    </aside>
  );
}

export function ShowcaseOverview() {
  const modules = [
    {
      eyebrow: "OPERATIONS",
      title: "Order Queue",
      detail: "1 submitted order · 2 items",
      status: "Live preview",
      href: "/operations/orders",
    },
    {
      eyebrow: "KITCHEN",
      title: "Kitchen Board",
      detail: "1 queued work item · allergen review required",
      status: "Needs attention",
      href: "/operations/kitchen",
    },
    {
      eyebrow: "CATALOG",
      title: "Menus",
      detail: "1 approved menu · 1 unresolved validation issue",
      status: "Review",
      href: "/app/commerce/menus",
    },
    {
      eyebrow: "ORGANIZATION",
      title: "Store Configuration",
      detail: "Training Store · draft version 3",
      status: "Draft",
      href: "/app/organization/stores",
    },
    {
      eyebrow: "COMPLIANCE",
      title: "Compliance Dashboard",
      detail: "1 overdue signal · evidence 1 of 2",
      status: "Action required",
      href: "/app/compliance",
    },
    {
      eyebrow: "PLATFORM · NONPRODUCTION",
      title: "Support Cases",
      detail: "1 synthetic case · no active access grant",
      status: "Read only",
      href: "/platform/support-cases",
    },
  ] as const;
  return (
    <>
      <section className="showcase-summary" aria-label="Synthetic daily summary">
        <article>
          <span>Orders today</span>
          <strong>42</strong>
          <small>+8% synthetic trend</small>
        </article>
        <article>
          <span>Net sales</span>
          <strong>CAD $1,284.60</strong>
          <small>Training data only</small>
        </article>
        <article>
          <span>Kitchen queue</span>
          <strong>1 item</strong>
          <small>Oldest age 12 min</small>
        </article>
        <article>
          <span>Compliance</span>
          <strong>1 overdue</strong>
          <small>Evidence incomplete</small>
        </article>
      </section>
      <section className="showcase-section" aria-labelledby="workspace-heading">
        <div className="showcase-section-heading">
          <div>
            <p className="bop-eyebrow">WORKSPACE</p>
            <h3 id="workspace-heading">Explore the operating system</h3>
          </div>
          <p className="bop-muted">Every card opens a deterministic, read-only workflow.</p>
        </div>
        <div className="showcase-module-grid">
          {modules.map((module) => (
            <a className="showcase-module-card" href={module.href} key={module.href}>
              <span className="bop-eyebrow">{module.eyebrow}</span>
              <span className="showcase-module-title">{module.title}</span>
              <span className="bop-muted">{module.detail}</span>
              <span className="showcase-module-footer">
                <span>{module.status}</span>
                <span aria-hidden="true">Open →</span>
              </span>
            </a>
          ))}
        </div>
      </section>
      <section className="showcase-activity" aria-labelledby="activity-heading">
        <div>
          <p className="bop-eyebrow">RECENT ACTIVITY</p>
          <h3 id="activity-heading">Synthetic operating timeline</h3>
        </div>
        <ol>
          <li>
            <strong>Order ORD-1001 submitted</strong>
            <span>Pickup · QR · 2 items</span>
          </li>
          <li>
            <strong>Kitchen work queued</strong>
            <span>Mushroom rice bowl · allergen review required</span>
          </li>
          <li>
            <strong>Menu validation needs review</strong>
            <span>Synthetic All Day · 1 unresolved issue</span>
          </li>
        </ol>
      </section>
    </>
  );
}
