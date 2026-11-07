"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { canSeeCosts, useApp } from "@/components/session";
import { loadDay, type Purchase } from "@/lib/data";
import { formatDayShort, isIsoDate, kyivToday } from "@/lib/dates";
import { humanError } from "@/lib/errors";
import { formatPrice, formatQty, UNIT_LABEL } from "@/lib/money";

/** Накладная за день: товар, вес (кол-во) и цена прихода. Без закупочных цен. */
export function InvoiceScreen() {
  const { shop } = useApp();
  const params = useSearchParams();
  const raw = params.get("d");
  const day = raw && isIsoDate(raw) ? raw : kyivToday();
  const [rows, setRows] = useState<{ day: string; list: Purchase[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadDay(shop.id, day, canSeeCosts(shop.role))
      .then((r) => !cancelled && setRows({ day, list: r.purchases }))
      .catch((e) => !cancelled && setError(humanError(e)));
    return () => {
      cancelled = true;
    };
  }, [shop.id, shop.role, day]);

  const list = rows?.day === day ? rows.list : null;
  const title = `Накладная за ${formatDayShort(day)}`;
  const text = list
    ? [
        title,
        ...list.map(
          (p, i) => `${i + 1}. ${p.product_name} — ${formatQty(p.qty)} ${UNIT_LABEL[p.unit]} — ${formatPrice(p.sell_price_kop)} ₴`,
        ),
      ]
        .join("\n")
        .replace(/ /g, " ")
    : "";

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ title, text });
        return;
      }
    } catch {
      return; // пользователь закрыл окно «Поделиться»
    }
    await copy();
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Не удалось скопировать. Выделите текст накладной пальцем и скопируйте вручную.");
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-10 pt-[max(12px,env(safe-area-inset-top))] print:max-w-none print:p-0">
      <div className="no-print mb-3 flex items-center justify-between gap-2">
        <Link href={day === kyivToday() ? "/" : `/?d=${day}`} className="btn">
          ‹ Назад
        </Link>
      </div>

      <section className="card print:border-0 print:p-0">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-muted">{shop.name}</p>
        {error && <p className="alert alert-error mt-3">{error}</p>}
        {!list && !error && <p className="mt-3 text-muted">Загрузка…</p>}
        {list && list.length === 0 && <p className="mt-3 text-muted">За этот день закупок нет.</p>}
        {list && list.length > 0 && (
          <table className="num mt-4 w-full border-collapse text-base">
            <thead>
              <tr className="border-b-2 border-line text-left text-sm text-muted">
                <th className="py-2 pr-2 font-semibold">№</th>
                <th className="py-2 pr-2 font-semibold">Товар</th>
                <th className="py-2 pr-2 text-right font-semibold">Вес</th>
                <th className="py-2 text-right font-semibold">Цена, ₴</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p, i) => (
                <tr key={p.id} className="border-b border-line">
                  <td className="py-2 pr-2 text-muted">{i + 1}</td>
                  <td className="py-2 pr-2">{p.product_name}</td>
                  <td className="whitespace-nowrap py-2 pr-2 text-right">
                    {formatQty(p.qty)} {UNIT_LABEL[p.unit]}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right font-semibold">{formatPrice(p.sell_price_kop)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {list && list.length > 0 && (
        <div className="no-print mt-4 flex flex-col gap-2">
          <button className="btn btn-primary" onClick={share}>
            📤 Отправить (Telegram, Viber…)
          </button>
          <div className="flex gap-2">
            <button className="btn flex-1" onClick={copy}>
              {copied ? "✓ Скопировано" : "Копировать текст"}
            </button>
            <button className="btn flex-1" onClick={() => window.print()}>
              🖨 Печать / PDF
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
