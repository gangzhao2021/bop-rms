import { Link } from "react-router";

const unavailableFields = [
  "Table / session",
  "Active Order batches",
  "Shared payable summary",
  "Service / allergen notices",
] as const;

export function DiningSessionPage() {
  return (
    <main id="main-content" className="order-status dining-session">
      <header className="cart-page__header delivery-status__header">
        <p className="cart-page__eyebrow">BOP</p>
        <p className="delivery-status__title">Dine-in session</p>
        <p>Guest session · exact Store scope required</p>
      </header>
      <nav
        className="cart-page__navigation delivery-status__navigation dining-session__navigation"
        aria-label="Customer journey"
      >
        <Link to="/">Entry</Link>
        <span aria-current="page">Dine-in</span>
        <Link to="/menu">Menu</Link>
        <Link to="/cart">Cart</Link>
        <Link to="/checkout">Checkout</Link>
      </nav>
      <div className="delivery-status__intro">
        <h1>Your dining session</h1>
        <p>A Guest-scoped view of your shared dining session.</p>
      </div>
      <section className="order-status__unavailable dining-session__unavailable" role="alert">
        <span className="order-status__unavailable-icon" aria-hidden="true">
          !
        </span>
        <h2>Session details are unavailable</h2>
        <p>Authorized session data is unavailable.</p>
        <ul className="dining-session__unavailable-fields">
          {unavailableFields.map((field) => (
            <li key={field}>{field} · unavailable</li>
          ))}
        </ul>
      </section>
      <Link className="order-status__back" to="/">
        Return to entry
      </Link>
    </main>
  );
}
