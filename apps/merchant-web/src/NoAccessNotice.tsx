import { createContext, useContext } from "react";
import { Link } from "react-router";
import {
  backToKitchenText,
  kitchenOnlyAccessDeniedText,
  kitchenOnlyNavigation,
  pageAccessDeniedText,
} from "./access-denied.js";
import type { MerchantNavigationItem } from "./merchant-workspace.js";

/** The signed-in person's navigation, as the workspace frame shows it (null outside the frame). */
export const StaffNavigationContext = createContext<readonly MerchantNavigationItem[] | null>(null);

/**
 * Batch 38: the body of a page the server refused (403). A kitchen display sign-in, or a cook whose
 * role is the kitchen alone, reads that the page is outside kitchen work and gets the way back to
 * the kitchen; anyone else reads what to ask for. Never the refused permission, Store or session.
 */
export function NoAccessNotice() {
  const items = useContext(StaffNavigationContext);
  if (items !== null && kitchenOnlyNavigation(items))
    return (
      <>
        <p>{kitchenOnlyAccessDeniedText}</p>
        <p>
          <Link to="/operations/kitchen">{backToKitchenText}</Link>
        </p>
      </>
    );
  return <p>{pageAccessDeniedText}</p>;
}
