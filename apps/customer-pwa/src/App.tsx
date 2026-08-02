import { Route, Routes } from "react-router";
import { CartPage } from "./cart/CartPage.js";
import { CustomerShell } from "./CustomerShell.js";
export function App() {
  return (
    <Routes>
      <Route path="/cart" element={<CartPage />} />
      <Route path="*" element={<CustomerShell />} />
    </Routes>
  );
}
