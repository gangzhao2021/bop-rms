/**
 * WP-2423 M71: "List it" confirms the menu's own price draft as the review read it. Tests read it
 * the same way (the price list of the Brand, the open MenuListing draft) before listing.
 */
export async function confirmedMenuPrices(prices, session = { sessionCookie: "c", csrf: "c" }) {
  const draft = (await prices.query({ ...session, priceBookReference: null })).books.find(
    (book) => book.lifecycle === "Draft" && book.purpose === "MenuListing",
  );
  return draft === undefined
    ? null
    : { priceBookReference: draft.priceBookReference, aggregateVersion: draft.aggregateVersion };
}
