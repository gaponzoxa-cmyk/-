import { Suspense } from "react";
import { DayScreen } from "./day/day-screen";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <DayScreen />
    </Suspense>
  );
}
