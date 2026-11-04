"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { canEnter, canSeeCosts, useApp } from "@/components/session";
import { Shell, useQueue } from "@/components/shell";
import {
  loadDay,
  loadDirectory,
  PAY_LABEL,
  type DayData,
  type Directory,
  type Expense,
  type Purchase,
} from "@/lib/data";
import { addDays, formatDayLong, isIsoDate, kyivToday } from "@/lib/dates";
import { humanError } from "@/lib/errors";
import { formatMoney, formatPct, formatPrice, formatQty, markupPct, reconcile, UNIT_LABEL } from "@/lib/money";
import { enqueue } from "@/lib/queue";
import { seedRowsWithIds } from "@/lib/seed";
import { CashSheet, ExpenseSheet, WriteoffSheet } from "./other-sheets";
import { PurchaseSheet } from "./purchase-sheet";

type Open =
  | { kind: "purchase"; editing: Purchase | null }
  | { kind: "cash" }
  | { kind: "expense"; editing: Expense | null }
  | { kind: "writeoff" }
  | null;

export function DayScreen() {
  const { shop } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const today = kyivToday();
  const raw = params.get("d");
  const day = raw && isIsoDate(raw) ? raw : today;
  const seesCosts = canSeeCosts(shop.role);
  const enters = canEnter(shop.role);
  const isOwner = shop.role === "owner";

  const go = useCallback(
    (d: string) => router.replace(d === today ? "/" : `/?d=${d}`, { scroll: false }),
    [router, today],
  );

  const [dir, setDir] = useState<Directory | null>(null);
  const [data, setData] = useState<{ key: string; d: DayData; offline: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const key = `${shop.id}:${day}`;
  const reqRef = useRef(0);

  const reload = useCallback(
    (localOnly: boolean) => {
      const req = ++reqRef.current;
      loadDay(shop.id, day, seesCosts, localOnly)
        .then((r) => {
          if (req !== reqRef.current) return;
          setData({ key, d: r, offline: r.offline });
          setError(null);
        })
        .catch((e) => req === reqRef.current && setError(humanError(e)));
    },
    [shop.id, day, seesCosts, key],
  );

  useEffect(() => {
    let cancelled = false;
    loadDirectory(shop.id, seesCosts, kyivToday())
      .then((d) => !cancelled && setDir(d))
      .catch((e) => !cancelled && setError(humanError(e)));
    return () => {
      cancelled = true;
    };
  }, [shop.id, seesCosts]);

  useEffect(() => {
    reload(false);
  }, [reload]);

  // Разовое исправление (04.11.2026): у перенесённых позиций 1–4 ноября
  // оплата была «из кассы», а владелец платит из вчерашней выручки.
  useEffect(() => {
    if (shop.role !== "owner") return;
    const flag = `kassa-fix-seedpay:${shop.id}`;
    try {
      if (localStorage.getItem(flag)) return;
      localStorage.setItem(flag, "1");
    } catch {
      return;
    }
    void seedRowsWithIds(shop.id).then((rows) => {
      for (const r of rows) enqueue({ kind: "update", table: "purchases", id: r.id, patch: { pay_source: "own" } });
    });
  }, [shop.id, shop.role]);

  // когда очередь опустела — перечитываем с сервера (там точные суммы)
  const { pending } = useQueue();
  const hadPending = useRef(false);
  useEffect(() => {
    if (pending.length > 0) hadPending.current = true;
    else if (hadPending.current) {
      hadPending.current = false;
      reload(false);
      loadDirectory(shop.id, seesCosts, kyivToday()).then(setDir).catch(() => {});
    }
  }, [pending.length, reload, shop.id, seesCosts]);

  const d = data?.key === key ? data.d : null;
  const afterChange = () => reload(true);

  // итоги дня — те же формулы, что и в базе (lib/money.ts)
  const buy = d?.purchases.reduce((a, p) => a + (p.buy_sum_kop ?? 0), 0) ?? 0;
  const sell = d?.purchases.reduce((a, p) => a + p.sell_sum_kop, 0) ?? 0;
  const paidCash = d?.purchases.reduce((a, p) => a + p.paid_cash_kop, 0) ?? 0;
  const expenses = d?.expenses.reduce((a, e) => a + e.amount_kop, 0) ?? 0;
  const expensesCash = d?.expenses.filter((e) => e.from_register).reduce((a, e) => a + e.amount_kop, 0) ?? 0;
  const writeoffs = d?.writeoffs.reduce((a, w) => a + (w.sum_kop ?? 0), 0) ?? 0;
  const cashEntered = d?.cash?.cash_evening_kop != null && d?.cash?.terminal_kop != null;
  const rec =
    d && cashEntered
      ? reconcile(
          {
            cashEvening: d.cash!.cash_evening_kop!,
            cashMorning: d.cash!.cash_morning_kop ?? 0,
            terminal: d.cash!.terminal_kop!,
            fromCard: d.cash!.from_card_kop,
            takenByOwner: d.cash!.taken_by_owner_kop,
            paidSuppliersCash: paidCash,
            expensesCash,
          },
          { sellTotal: sell, soldOnCredit: 0, debtRepaid: 0 },
        )
      : null;

  return (
    <Shell>
      <nav className="flex items-center gap-2" aria-label="Выбор дня">
        <button className="btn btn-icon" onClick={() => go(addDays(day, -1))} aria-label="Предыдущий день">
          ‹
        </button>
        <div className="flex-1 text-center">
          <div className="text-lg font-semibold">{formatDayLong(day)}</div>
          {day !== today && (
            <button className="text-sm text-primary underline" onClick={() => go(today)}>
              Сегодня
            </button>
          )}
        </div>
        <button className="btn btn-icon" onClick={() => go(addDays(day, 1))} aria-label="Следующий день">
          ›
        </button>
      </nav>

      {error && <p className="alert alert-error mt-3">{error}</p>}
      {data?.offline && <p className="alert alert-warn mt-3">Нет связи — показаны сохранённые данные.</p>}

      {seesCosts && (
        <section className="card mt-4" aria-label="Итоги дня">
          <div className="text-sm text-muted">Заработок за день</div>
          <div className={`num text-4xl font-bold ${sell - buy < 0 ? "text-bad" : "text-good"}`}>
            {d ? formatMoney(sell - buy) : "…"}
          </div>
          <dl className="num mt-3 flex flex-col gap-1 text-base">
            <Row label="Закупка" value={formatMoney(buy)} />
            <Row label="Приход" value={formatMoney(sell)} />
            <Row label="Расходы" value={formatMoney(expenses)} muted />
            <Row label="Списание" value={formatMoney(writeoffs)} muted />
            <Row label="Позиций" value={String(d?.purchases.length ?? 0)} muted />
          </dl>
          {d && !cashEntered && <p className="alert alert-warn mt-3">Касса за этот день не введена.</p>}
          {rec && d?.cash && (
            <div className="num mt-3 border-t border-line pt-3">
              <Row label="Наличные в кассе" value={formatMoney(d.cash.cash_evening_kop!)} />
              <Row label="Терминал" value={formatMoney(d.cash.terminal_kop!)} />
              <Row label="Касса (нал + терминал)" value={formatMoney(d.cash.cash_evening_kop! + d.cash.terminal_kop!)} />
              <details className="mt-2">
                <summary className="flex cursor-pointer justify-between gap-2">
                  <span className="text-muted underline">Сверка выручки с приходом</span>
                  <span className={`font-bold ${rec.diff < 0 ? "text-bad" : "text-good"}`}>
                    {rec.diff > 0 ? "+" : ""}
                    {formatMoney(rec.diff)}
                  </span>
                </summary>
                <div className="mt-2 flex flex-col gap-0.5 rounded-xl bg-bg p-3 text-sm">
                  <Row label="Наличные в кассе вечером" value={formatMoney(d.cash.cash_evening_kop!)} />
                  {(d.cash.cash_morning_kop ?? 0) > 0 && (
                    <Row label="− было утром (размен)" value={formatMoney(d.cash.cash_morning_kop ?? 0)} muted />
                  )}
                  {d.cash.from_card_kop > 0 && <Row label="− положил с карты" value={formatMoney(d.cash.from_card_kop)} muted />}
                  {paidCash > 0 && <Row label="+ отдано поставщикам из кассы" value={formatMoney(paidCash)} muted />}
                  {expensesCash > 0 && <Row label="+ расходы из кассы" value={formatMoney(expensesCash)} muted />}
                  {d.cash.taken_by_owner_kop > 0 && <Row label="+ забрал себе" value={formatMoney(d.cash.taken_by_owner_kop)} muted />}
                  <Row label="= выручка наличными" value={formatMoney(rec.revenueCash)} />
                  <Row label="+ терминал" value={formatMoney(d.cash.terminal_kop!)} muted />
                  <Row label="= выручка за день" value={formatMoney(rec.revenueTotal)} />
                  <Row label="Приход (товар по цене продажи)" value={formatMoney(rec.expected)} />
                  <div className="flex justify-between gap-2 font-bold">
                    <span>Разница</span>
                    <span className={rec.diff < 0 ? "text-bad" : "text-good"}>
                      {rec.diff > 0 ? "+" : ""}
                      {formatMoney(rec.diff)} ({rec.diffPct !== null ? formatPct(rec.diffPct) : "—"})
                    </span>
                  </div>
                  <p className="mt-1 text-muted">
                    Приход — это товар, купленный сегодня, по цене продажи. Часть его продастся завтра, поэтому
                    небольшая разница нормальна. Закупки с оплатой «Из кассы» прибавляются к выручке.
                  </p>
                </div>
              </details>
            </div>
          )}
        </section>
      )}

      {/* ───── Приход ───── */}
      <section className="mt-4">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-lg font-bold">Приход товара</h2>
          <span className="text-sm text-muted">{d?.purchases.length ?? 0} поз.</span>
        </div>
        {enters && (
          <button
            className="btn btn-primary mt-2 w-full"
            disabled={!dir}
            onClick={() => setOpen({ kind: "purchase", editing: null })}
          >
            + Добавить позицию
          </button>
        )}
        <ul className="mt-2 flex flex-col gap-2">
          {d?.purchases.map((p) => {
            const m = p.buy_price_kop !== null ? markupPct(p.buy_price_kop, p.sell_price_kop) : null;
            const low = m !== null && m < shop.low_markup_pct;
            return (
              <li key={p.id}>
                <button
                  className={`card w-full text-left ${low ? "!border-warn" : ""}`}
                  disabled={!isOwner}
                  onClick={() => isOwner && dir && setOpen({ kind: "purchase", editing: p })}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-semibold">
                      {p.pending && <span title="Ждёт отправки">⏳ </span>}
                      {p.product_name}
                    </span>
                    {p.buy_sum_kop !== null && (
                      <span className="num font-bold text-good">{formatMoney(p.sell_sum_kop - p.buy_sum_kop)}</span>
                    )}
                  </div>
                  <div className="num mt-1 text-sm text-muted">
                    {formatQty(p.qty)} {UNIT_LABEL[p.unit]}
                    {p.buy_price_kop !== null ? ` × ${formatPrice(p.buy_price_kop)} → ${formatPrice(p.sell_price_kop)} ₴` : ` · продажа ${formatPrice(p.sell_price_kop)} ₴`}
                    {m !== null && <span className={low ? "font-bold text-warn" : ""}> · {formatPct(m, 0)}</span>}
                  </div>
                  {seesCosts && (
                    <div className="num text-sm text-muted">
                      {formatMoney(p.buy_sum_kop ?? 0)} → {formatMoney(p.sell_sum_kop)}
                      {p.supplier_name && ` · ${p.supplier_name}`}
                      {p.pay_source !== "own" && ` · ${PAY_LABEL[p.pay_source]}`}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {d && d.purchases.length === 0 && <p className="mt-2 px-1 text-muted">Закупок за этот день нет.</p>}
      </section>

      {/* ───── Касса ───── */}
      <section className="card mt-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold">Касса за день</h2>
          {enters && (
            <button className="font-semibold text-primary underline" onClick={() => setOpen({ kind: "cash" })}>
              {cashEntered ? "Изменить" : "Ввести"}
            </button>
          )}
        </div>
        {cashEntered && d?.cash ? (
          <dl className="num mt-2 flex flex-col gap-1">
            <Row label="Наличные в кассе" value={formatMoney(d.cash.cash_evening_kop!)} />
            <Row label="Терминал" value={formatMoney(d.cash.terminal_kop!)} />
            {d.cash.from_card_kop > 0 && <Row label="Снял с карты" value={formatMoney(d.cash.from_card_kop)} muted />}
            {d.cash.taken_by_owner_kop > 0 && <Row label="Забрал себе" value={formatMoney(d.cash.taken_by_owner_kop)} muted />}
            {d.cash.comment && <p className="text-sm text-muted">{d.cash.comment}</p>}
          </dl>
        ) : (
          <p className="mt-1 text-muted">Не введена. Вечером пересчитайте наличные и введите терминал.</p>
        )}
      </section>

      {/* ───── Расходы и списания ───── */}
      <section className="card mt-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold">Расходы</h2>
          {enters && (
            <button className="font-semibold text-primary underline" onClick={() => setOpen({ kind: "expense", editing: null })}>
              + Расход
            </button>
          )}
        </div>
        <ul className="mt-1">
          {d?.expenses.map((e) => (
            <li key={e.id}>
              <button
                className="flex w-full justify-between gap-2 py-2 text-left"
                onClick={() => enters && setOpen({ kind: "expense", editing: e })}
              >
                <span>
                  {e.pending && "⏳ "}
                  {e.category}
                  {e.comment && <span className="text-muted"> · {e.comment}</span>}
                  {!e.from_register && <span className="text-sm text-muted"> (не из кассы)</span>}
                </span>
                <span className="num font-semibold">{formatMoney(e.amount_kop)}</span>
              </button>
            </li>
          ))}
        </ul>
        {d && d.expenses.length === 0 && <p className="text-muted">Расходов нет.</p>}

        <div className="mt-4 flex items-baseline justify-between border-t border-line pt-3">
          <h2 className="text-lg font-bold">Списания</h2>
          {enters && (
            <button className="font-semibold text-primary underline" disabled={!dir} onClick={() => setOpen({ kind: "writeoff" })}>
              + Списание
            </button>
          )}
        </div>
        <ul className="mt-1">
          {d?.writeoffs.map((w) => (
            <li key={w.id} className="flex justify-between gap-2 py-2">
              <span>
                {w.pending && "⏳ "}
                {w.product_name} · <span className="num">{formatQty(w.qty)}</span>
                {w.reason && <span className="text-muted"> · {w.reason}</span>}
              </span>
              {w.sum_kop !== null && <span className="num font-semibold">{formatMoney(w.sum_kop)}</span>}
            </li>
          ))}
        </ul>
        {d && d.writeoffs.length === 0 && <p className="text-muted">Списаний нет.</p>}
        {seesCosts && (
          <p className="mt-2 text-sm text-muted">Расходы и списания не вычитаются из заработка дня.</p>
        )}
      </section>

      {open?.kind === "purchase" && dir && d && (
        <PurchaseSheet
          shop={shop}
          day={day}
          dir={dir}
          dayRows={d.purchases}
          editing={open.editing}
          asSeller={!isOwner}
          onClose={() => setOpen(null)}
          onSaved={afterChange}
          onDirectoryChange={setDir}
        />
      )}
      {open?.kind === "cash" && d && (
        <CashSheet
          shop={shop}
          day={day}
          cash={d.cash}
          paidSuppliersCash={paidCash}
          expensesCash={expensesCash}
          onClose={() => setOpen(null)}
          onSaved={afterChange}
        />
      )}
      {open?.kind === "expense" && (
        <ExpenseSheet
          shop={shop}
          day={day}
          editing={open.editing}
          canDelete={enters}
          onClose={() => setOpen(null)}
          onSaved={afterChange}
        />
      )}
      {open?.kind === "writeoff" && dir && (
        <WriteoffSheet
          shop={shop}
          day={day}
          dir={dir}
          seesCosts={seesCosts}
          onClose={() => setOpen(null)}
          onSaved={afterChange}
        />
      )}
    </Shell>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${muted ? "text-muted" : ""}`}>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
