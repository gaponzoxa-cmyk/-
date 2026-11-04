"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { canSeeCosts, useApp } from "@/components/session";
import { Shell } from "@/components/shell";
import { addDays, formatDayShort, kyivToday, weekdayShort } from "@/lib/dates";
import { humanError } from "@/lib/errors";
import { formatMoney, reconcile, type Kop } from "@/lib/money";
import { supabase } from "@/lib/supabase";

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

type DayTotal = {
  day: string;
  purchase_count: number;
  buy_kop: Kop;
  sell_kop: Kop;
  profit_kop: Kop;
  paid_suppliers_cash_kop: Kop;
  expenses_kop: Kop;
  expenses_cash_kop: Kop;
  writeoffs_kop: Kop;
  sold_on_credit_kop: Kop;
  debt_repaid_kop: Kop;
  cash_evening_kop: Kop | null;
  terminal_kop: Kop | null;
  cash_morning_kop: Kop;
  from_card_kop: Kop;
  taken_by_owner_kop: Kop;
  cash_entered: boolean;
};

function monthBounds(m: string) {
  const [y, mo] = m.split("-").map(Number);
  const first = `${m}-01`;
  const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
  return { first, last: addDays(next, -1), y, mo };
}
function shiftMonth(m: string, n: number) {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export function MonthScreen() {
  const { shop } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const current = kyivToday().slice(0, 7);
  const raw = params.get("m");
  const m = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : current;
  const { first, last, y, mo } = monthBounds(m);
  const [rows, setRows] = useState<{ m: string; list: DayTotal[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase()
      .from("day_totals")
      .select("*")
      .eq("shop_id", shop.id)
      .gte("day", first)
      .lte("day", last)
      .order("day")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(humanError(error));
        else {
          setError(null);
          setRows({ m, list: (data ?? []) as DayTotal[] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shop.id, first, last, m]);

  const go = (x: string) => router.replace(x === current ? "/month" : `/month?m=${x}`, { scroll: false });
  const list = rows?.m === m ? rows.list : null;

  if (!canSeeCosts(shop.role)) {
    return (
      <Shell>
        <p className="card mt-4">Итоги месяца доступны владельцу магазина.</p>
      </Shell>
    );
  }

  const withCash = (list ?? []).map((r) => {
    const rec = r.cash_entered
      ? reconcile(
          {
            cashEvening: r.cash_evening_kop!,
            cashMorning: r.cash_morning_kop,
            terminal: r.terminal_kop!,
            fromCard: r.from_card_kop,
            takenByOwner: r.taken_by_owner_kop,
            paidSuppliersCash: r.paid_suppliers_cash_kop,
            expensesCash: r.expenses_cash_kop,
          },
          { sellTotal: r.sell_kop, soldOnCredit: r.sold_on_credit_kop, debtRepaid: r.debt_repaid_kop },
        )
      : null;
    return { ...r, rec };
  });
  const sum = (f: (r: (typeof withCash)[number]) => number) => withCash.reduce((a, r) => a + f(r), 0);
  const tot = {
    buy: sum((r) => r.buy_kop),
    sell: sum((r) => r.sell_kop),
    profit: sum((r) => r.profit_kop),
    cash: sum((r) => r.rec?.revenueCash ?? 0),
    term: sum((r) => (r.cash_entered ? (r.terminal_kop ?? 0) : 0)),
    exp: sum((r) => r.expenses_kop),
    wo: sum((r) => r.writeoffs_kop),
    count: sum((r) => r.purchase_count),
  };
  const noCashDays = withCash.filter((r) => !r.cash_entered && r.purchase_count > 0).length;

  return (
    <Shell>
      <nav className="flex items-center gap-2" aria-label="Выбор месяца">
        <button className="btn btn-icon" onClick={() => go(shiftMonth(m, -1))} aria-label="Предыдущий месяц">
          ‹
        </button>
        <div className="flex-1 text-center text-lg font-semibold">
          {MONTHS[mo - 1]} {y}
          {m !== current && (
            <div>
              <button className="text-sm font-normal text-primary underline" onClick={() => go(current)}>
                Текущий месяц
              </button>
            </div>
          )}
        </div>
        <button className="btn btn-icon" onClick={() => go(shiftMonth(m, 1))} aria-label="Следующий месяц">
          ›
        </button>
      </nav>
      {error && <p className="alert alert-error mt-3">{error}</p>}

      <section className="card mt-4">
        <div className="text-sm text-muted">Заработок за месяц (приход − закупка)</div>
        <div className="num text-4xl font-bold text-good">{list ? formatMoney(tot.profit) : "…"}</div>
        <dl className="num mt-3 flex flex-col gap-1">
          <R label="Закупка" v={tot.buy} />
          <R label="Приход" v={tot.sell} />
          <R label="Касса: наличные" v={tot.cash} />
          <R label="Касса: терминал" v={tot.term} />
          <R label="Касса всего" v={tot.cash + tot.term} />
          <R label="Расходы" v={tot.exp} />
          <R label="Списания" v={tot.wo} />
          <div className="flex justify-between text-muted">
            <dt>Позиций закупки</dt>
            <dd>{tot.count}</dd>
          </div>
        </dl>
        {noCashDays > 0 && <p className="alert alert-warn mt-3">Касса не введена в {noCashDays} дн.</p>}
      </section>

      <ul className="mt-4 flex flex-col gap-2">
        {withCash.map((r) => (
          <li key={r.day}>
            <Link href={`/?d=${r.day}`} className="card block">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">
                  {formatDayShort(r.day).slice(0, 5)} <span className="text-muted">{weekdayShort(r.day)}</span>
                </span>
                <span className="num font-bold text-good">{formatMoney(r.profit_kop)}</span>
              </div>
              <div className="num mt-1 grid grid-cols-2 gap-x-3 text-sm text-muted">
                <span>Закупка {formatMoney(r.buy_kop)}</span>
                <span>Приход {formatMoney(r.sell_kop)}</span>
                {r.rec ? (
                  <>
                    <span>Нал {formatMoney(r.rec.revenueCash)}</span>
                    <span>Терм {formatMoney(r.terminal_kop ?? 0)}</span>
                    <span className={r.rec.diff < 0 ? "text-bad" : ""}>
                      Сверка {r.rec.diff > 0 ? "+" : ""}
                      {formatMoney(r.rec.diff)}
                    </span>
                  </>
                ) : (
                  <span className="col-span-2 text-warn">Касса не введена</span>
                )}
                {r.expenses_kop > 0 && <span>Расходы {formatMoney(r.expenses_kop)}</span>}
                {r.writeoffs_kop > 0 && <span>Списано {formatMoney(r.writeoffs_kop)}</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {list && list.length === 0 && <p className="mt-4 text-muted">В этом месяце записей нет.</p>}
    </Shell>
  );
}

function R({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{formatMoney(v)}</dd>
    </div>
  );
}
