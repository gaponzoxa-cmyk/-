import { Suspense } from "react";
import { InvoiceScreen } from "./invoice-screen";

export default function InvoicePage() {
  return (
    <Suspense fallback={null}>
      <InvoiceScreen />
    </Suspense>
  );
}
