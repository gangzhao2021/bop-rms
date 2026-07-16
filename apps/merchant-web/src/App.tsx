import { Route, Routes } from "react-router";
import { MerchantShell } from "./MerchantShell.js";
export function App() {
  return (
    <Routes>
      <Route path="*" element={<MerchantShell />} />
    </Routes>
  );
}
