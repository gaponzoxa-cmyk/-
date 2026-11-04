import { Suspense } from "react";
import { MonthScreen } from "./month-screen";

export default function MonthPage() {
  return (
    <Suspense fallback={null}>
      <MonthScreen />
    </Suspense>
  );
}
