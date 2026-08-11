import { Route, Routes } from "react-router";
import { CartPage } from "./cart/CartPage.js";
import { CustomerShell } from "./CustomerShell.js";
import { EntryContextPage } from "./entry/EntryContextPage.js";
import type { CustomerEntryClient } from "./entry/types.js";

export function App({ entryClient }: Readonly<{ entryClient?: CustomerEntryClient | undefined }>) {
  return (
    <Routes>
      <Route path="/" element={<EntryContextPage client={entryClient} />} />
      <Route path="/cart" element={<CartPage />} />
      <Route path="*" element={<CustomerShell />} />
    </Routes>
  );
}
