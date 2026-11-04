import { Suspense } from "react";
import { SessionGate } from "@/components/session";
import { DayScreen } from "./day/day-screen";

export default function Home() {
  return (
    <SessionGate>
      <Suspense fallback={null}>
        <DayScreen />
      </Suspense>
    </SessionGate>
  );
}
