"use client";

import Link from "next/link";
import { useApp } from "@/components/session";
import { Shell } from "@/components/shell";

const ROLE: Record<string, string> = { owner: "владелец", seller: "продавец", viewer: "просмотр" };

export default function MorePage() {
  const { shop, session, signOut } = useApp();
  const isOwner = shop.role === "owner";
  return (
    <Shell>
      <h1 className="mt-2 text-2xl font-bold">Ещё</h1>
      <p className="mt-1 text-muted">
        {session.user.email} · {ROLE[shop.role]}
      </p>
      <nav className="mt-4 flex flex-col gap-2">
        {isOwner && (
          <>
            <Link href="/import" className="card text-lg font-semibold">
              📥 Перенос данных 1–4 ноября
            </Link>
            <Link href="/trash" className="card text-lg font-semibold">
              🗑 Корзина
            </Link>
          </>
        )}
        <button className="card text-left text-lg font-semibold text-bad" onClick={signOut}>
          Выйти из приложения
        </button>
      </nav>
    </Shell>
  );
}
