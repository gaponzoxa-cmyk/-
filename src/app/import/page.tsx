"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/session";
import { Shell } from "@/components/shell";
import { createProduct, findByName, loadDirectory, qtyToDb } from "@/lib/data";
import { formatDayShort, kyivToday } from "@/lib/dates";
import { humanError } from "@/lib/errors";
import { stableId } from "@/lib/ids";
import { dayPurchaseTotals, formatMoney, formatPrice, formatQty, UNIT_LABEL } from "@/lib/money";
import { enqueue } from "@/lib/queue";
import { SEED_CONTROL, seedRows } from "@/lib/seed";
import { supabase } from "@/lib/supabase";

const DAYS = Object.keys(SEED_CONTROL);

export default function ImportPage() {
  const { shop } = useApp();
  const rows = useMemo(() => seedRows(), []);
  const days = DAYS;
  const [existing, setExisting] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase()
      .from("purchases")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shop.id)
      .gte("day", days[0])
      .lte("day", days[days.length - 1])
      .is("deleted_at", null)
      .then(({ count, error }) => {
        if (error) setError(humanError(error));
        else setExisting(count ?? 0);
      });
  }, [shop.id, days]);

  const checks = days.map((d) => {
    const t = dayPurchaseTotals(rows.filter((r) => r.date === d));
    const c = SEED_CONTROL[d];
    return { day: d, t, ok: t.count === c.count && t.buy === c.buy && t.sell === c.sell && t.profit === c.profit };
  });
  const allOk = checks.every((c) => c.ok);

  async function run() {
    setState("busy");
    setError(null);
    try {
      let dir = await loadDirectory(shop.id, true, kyivToday());
      const pos: Record<string, number> = {};
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        let product = findByName(dir.products, r.name);
        if (!product) {
          product = createProduct(shop.id, r.name, r.unit);
          dir = { ...dir, products: [...dir.products, product] };
        }
        pos[r.date] = (pos[r.date] ?? 0) + 1;
        const id = await stableId(`seed-2026-11:${shop.id}:${r.date}:${pos[r.date]}:${r.name}`);
        enqueue(
          {
            kind: "insert",
            table: "purchases",
            row: {
              id,
              shop_id: shop.id,
              day: r.date,
              position: pos[r.date],
              product_id: product.id,
              qty: qtyToDb(r.qty),
              unit: r.unit,
              buy_input: "price",
              buy_price_kop: r.buyPrice,
              sell_price_kop: r.sellPrice,
              pay_source: "cash_register",
              comment: r.note ?? null,
            },
          },
          { product_name: r.name },
        );
      }
      setState("done");
    } catch (e) {
      setError(humanError(e));
      setState("idle");
    }
  }

  if (shop.role !== "owner")
    return (
      <Shell>
        <p className="card mt-4">Импорт доступен владельцу магазина.</p>
      </Shell>
    );

  return (
    <Shell>
      <h1 className="mt-2 text-2xl font-bold">Перенос данных 1–4 ноября</h1>
      <p className="mt-1 text-muted">Из старой таблицы Excel: {rows.length} позиций закупки. Касса за эти дни не вводилась.</p>

      <section className="card num mt-4">
        <h2 className="font-bold">Сверка с контрольными итогами</h2>
        {checks.map((c) => (
          <div key={c.day} className="mt-2 flex justify-between gap-2">
            <span>
              {c.ok ? "✅" : "❌"} {formatDayShort(c.day)} · {c.t.count} поз.
            </span>
            <span className="text-right text-sm">
              {formatMoney(c.t.buy)} → {formatMoney(c.t.sell)}
              <br />
              <b className="text-good">{formatMoney(c.t.profit)}</b>
            </span>
          </div>
        ))}
      </section>

      <section className="card mt-4">
        <h2 className="font-bold">Исправления (согласовано)</h2>
        <ul className="mt-2 flex flex-col gap-2 text-base">
          <li>
            • <b>Яйцо</b> 01.11: 300 <s>кг</s> → <b>300 шт</b> по 8,5 → 12 ₴. Суммы не меняются.
          </li>
          <li>
            • <b>Розовый</b> 04.11 по 68,6 ₴ — цена верная, оставлено.
          </li>
          <li>
            • <b>Сливка</b> и <b>Помидор красный</b> 04.11 — разные товары, обе строки остаются.
          </li>
        </ul>
      </section>

      <details className="card mt-4">
        <summary className="font-bold">Все позиции ({rows.length})</summary>
        <ul className="num mt-2 text-sm">
          {rows.map((r, i) => (
            <li key={i} className="flex justify-between gap-2 border-b border-line py-1">
              <span>
                {r.date.slice(8)}.{r.date.slice(5, 7)} {r.name}
              </span>
              <span className="text-muted">
                {formatQty(r.qty)} {UNIT_LABEL[r.unit]} × {formatPrice(r.buyPrice)} → {formatPrice(r.sellPrice)}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {error && <p className="alert alert-error mt-4">{error}</p>}
      {existing !== null && existing > 0 && state !== "done" && (
        <p className="alert alert-warn mt-4">
          За 1–4 ноября уже есть {existing} позиций. Повторный перенос не создаст дублей тех же строк, но если вы вводили
          эти дни вручную — позиции задвоятся. Проверьте дни перед переносом.
        </p>
      )}

      {state === "done" ? (
        <div className="alert mt-4 flex flex-col gap-3 bg-card text-good">
          <span>✓ Готово! {rows.length} позиций отправляются в базу (если нет связи — уйдут позже).</span>
          <div className="flex flex-wrap gap-2">
            {days.map((d) => (
              <Link key={d} href={`/?d=${d}`} className="btn">
                {formatDayShort(d).slice(0, 5)}
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <button className="btn btn-primary mt-4 w-full" disabled={!allOk || state === "busy" || existing === null} onClick={run}>
          {state === "busy" ? "Переносим…" : `Перенести ${rows.length} позиций`}
        </button>
      )}
    </Shell>
  );
}
