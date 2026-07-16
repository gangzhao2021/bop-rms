import { Route, Routes } from "react-router";
import { CustomerShell } from "./CustomerShell.js";
export function App() {
  return (
    <Routes>
      <Route path="*" element={<CustomerShell />} />
    </Routes>
  );
}
