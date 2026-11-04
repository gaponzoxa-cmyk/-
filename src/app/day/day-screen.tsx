"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { canSeeCosts, useApp } from "@/components/session";
import { addDays, formatDayLong, isIsoDate, kyivToday } from "@/lib/dates";
import { humanError } from "@/lib/errors";
import { formatMoney, reconcile } from "@/lib/money";
import { supabase } from "@/lib/supabase";

type DayTotals = {
  purchase_count: number;
  buy_kop: number;
  sell_kop: number;
  profit_kop: number;
  paid_suppliers_cash_kop: number;
  expenses_kop: number;
  expenses_cash_kop: number;
  writeoffs_kop: number;
  sold_on_credit_kop: number;
  debt_repaid_kop: number;
  cash_evening_kop: number | null;
  terminal_kop: number | null;
  cash_morning_kop: number;
  from_card_kop: number;
  taken_by_owner_kop: number;
  cash_entered: boolean;
};

export function DayScreen() {
  const { shop, signOut, session } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const today = kyivToday();
  const raw = params.get("d");
  const day = raw && isIsoDate(raw) ? raw : today;

  const go = useCallback(
    (d: string) => router.replace(d === today ? "/" : `/?d=${d}`, { scroll: false }),
    [router, today],
  );

  // результат загрузки помечен ключом (магазин+день): пока ключ не совпал — «загрузка»
  const key = `${shop.id}:${day}`;
  const [loaded, setLoaded] = useState<{ key: string; totals: DayTotals | null; error: string | null }>();
  const totals = loaded?.key === key ? loaded.totals : undefined;
  const error = loaded?.key === key ? loaded.error : null;
  const seesCosts = canSeeCosts(shop.role);

  useEffect(() => {
    let cancelled = false;
    supabase()
      .from("day_totals")
      .select("*")
      .eq("shop_id", shop.id)
      .eq("day", day)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        setLoaded({
          key,
          totals: error ? null : ((data as DayTotals | null) ?? null),
          error: error ? humanError(error) : null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [shop.id, day, key]);

  const t = totals ?? null;

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-24 pt-[max(12px,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between py-2">
        <span className="font-semibold">{shop.name}</span>
        <button className="text-sm text-muted underline" onClick={signOut} title={session.user.email}>
          Выйти
        </button>
      </header>

      <nav className="mt-2 flex items-center gap-2" aria-label="Выбор дня">
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

      {error && <p className="alert alert-error mt-4">{error}</p>}

      {seesCosts && (
        <section className="card mt-4" aria-label="Итоги дня">
          <div className="text-sm text-muted">Заработок за день</div>
          <div className="num text-4xl font-bold text-good">
            {totals === undefined ? "…" : formatMoney(t?.profit_kop ?? 0)}
          </div>
          <dl className="num mt-4 flex flex-col gap-1.5 text-base">
            <Row label="Закупка" value={t?.buy_kop} />
            <Row label="Приход" value={t?.sell_kop} />
            <Row label="Расходы" value={t?.expenses_kop} />
            <Row label="Списание" value={t?.writeoffs_kop} />
            <div className="flex justify-between text-muted">
              <span>Позиций</span>
              <span>{t?.purchase_count ?? 0}</span>
            </div>
          </dl>
          <CashSummary t={t} />
        </section>
      )}

      <section className="card mt-4">
        <h2 className="text-lg font-semibold">Приход товара</h2>
        <p className="mt-1 text-muted">Ввод позиций появится на этапе 1.</p>
      </section>
      <section className="card mt-4">
        <h2 className="text-lg font-semibold">Касса за день</h2>
        <p className="mt-1 text-muted">Наличные в кассе, терминал, снял с карты — этап 1.</p>
      </section>
      <section className="card mt-4">
        <h2 className="text-lg font-semibold">Расходы и списания</h2>
        <p className="mt-1 text-muted">Этап 1.</p>
      </section>
    </main>
  );
}

function Row({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{formatMoney(value ?? 0)}</dd>
    </div>
  );
}

function CashSummary({ t }: { t: DayTotals | null }) {
  if (!t || !t.cash_entered) {
    return <p className="alert alert-warn mt-4">Касса за этот день не введена.</p>;
  }
  const r = reconcile(
    {
      cashEvening: t.cash_evening_kop ?? 0,
      cashMorning: t.cash_morning_kop,
      terminal: t.terminal_kop ?? 0,
      fromCard: t.from_card_kop,
      takenByOwner: t.taken_by_owner_kop,
      paidSuppliersCash: t.paid_suppliers_cash_kop,
      expensesCash: t.expenses_cash_kop,
    },
    { sellTotal: t.sell_kop, soldOnCredit: t.sold_on_credit_kop, debtRepaid: t.debt_repaid_kop },
  );
  return (
    <div className="num mt-4 border-t border-line pt-3 text-base">
      <div className="flex justify-between">
        <span className="text-muted">Выручка нал / терминал</span>
        <span className="font-semibold">
          {formatMoney(r.revenueCash)} / {formatMoney(t.terminal_kop ?? 0)}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted">Сверка с приходом</span>
        <span className={`font-semibold ${r.diff < 0 ? "text-bad" : "text-good"}`}>
          {r.diff > 0 ? "+" : ""}
          {formatMoney(r.diff)}
        </span>
      </div>
    </div>
  );
}
