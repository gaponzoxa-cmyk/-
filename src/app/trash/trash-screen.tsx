"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/session";
import { Shell } from "@/components/shell";
import { restore } from "@/lib/data";
import { formatDayShort } from "@/lib/dates";
import { humanError } from "@/lib/errors";
import { formatMoney, formatQty, milliFromNumber } from "@/lib/money";
import { supabase } from "@/lib/supabase";

type Item = {
  table: "purchases" | "expenses" | "writeoffs";
  id: string;
  day: string;
  title: string;
  amount: number | null;
  deleted_at: string;
};

export function TrashScreen() {
  const { shop } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const sb = supabase();
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [p, e, w] = await Promise.all([
      sb.from("purchases").select("id,day,qty,buy_sum_kop,deleted_at,products(name)").eq("shop_id", shop.id).not("deleted_at", "is", null).gte("deleted_at", since),
      sb.from("expenses").select("id,day,category,amount_kop,deleted_at").eq("shop_id", shop.id).not("deleted_at", "is", null).gte("deleted_at", since),
      sb.from("writeoffs").select("id,day,qty,sum_kop,deleted_at,products(name)").eq("shop_id", shop.id).not("deleted_at", "is", null).gte("deleted_at", since),
    ]);
    const err = p.error ?? e.error ?? w.error;
    if (err) throw err;
    type R = Record<string, unknown>;
    const name = (r: R) => String((r.products as R | null)?.name ?? "?");
    const list: Item[] = [
      ...((p.data ?? []) as R[]).map((r) => ({
        table: "purchases" as const,
        id: String(r.id),
        day: String(r.day),
        title: `Закупка: ${name(r)}, ${formatQty(milliFromNumber(Number(r.qty)))}`,
        amount: Number(r.buy_sum_kop),
        deleted_at: String(r.deleted_at),
      })),
      ...((e.data ?? []) as R[]).map((r) => ({
        table: "expenses" as const,
        id: String(r.id),
        day: String(r.day),
        title: `Расход: ${String(r.category)}`,
        amount: Number(r.amount_kop),
        deleted_at: String(r.deleted_at),
      })),
      ...((w.data ?? []) as R[]).map((r) => ({
        table: "writeoffs" as const,
        id: String(r.id),
        day: String(r.day),
        title: `Списание: ${name(r)}, ${formatQty(milliFromNumber(Number(r.qty)))}`,
        amount: Number(r.sum_kop),
        deleted_at: String(r.deleted_at),
      })),
    ].sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
    return list;
  }, [shop.id]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((l) => !cancelled && setItems(l))
      .catch((e) => !cancelled && setError(humanError(e)));
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (shop.role !== "owner")
    return (
      <Shell>
        <p className="card mt-4">Корзина доступна владельцу магазина.</p>
      </Shell>
    );

  return (
    <Shell>
      <h1 className="mt-2 text-2xl font-bold">Корзина</h1>
      <p className="mt-1 text-muted">Удалённое хранится 30 дней, потом стирается.</p>
      {error && <p className="alert alert-error mt-3">{error}</p>}
      <ul className="mt-4 flex flex-col gap-2">
        {items?.map((i) => (
          <li key={i.id} className="card flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold">{i.title}</div>
              <div className="num text-sm text-muted">
                {formatDayShort(i.day)}
                {i.amount !== null && ` · ${formatMoney(i.amount)}`}
              </div>
            </div>
            {restored.has(i.id) ? (
              <span className="text-good">Восстановлено</span>
            ) : (
              <button
                className="btn shrink-0"
                onClick={() => {
                  restore(i.table, i.id);
                  setRestored((s) => new Set(s).add(i.id));
                }}
              >
                Вернуть
              </button>
            )}
          </li>
        ))}
      </ul>
      {items && items.length === 0 && <p className="mt-4 text-muted">Корзина пуста.</p>}
    </Shell>
  );
}
