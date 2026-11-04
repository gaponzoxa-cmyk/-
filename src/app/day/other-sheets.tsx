"use client";

import { useState } from "react";
import { ConfirmBar, NumField, Segmented, Sheet, SuggestField, useFocusRef } from "@/components/ui";
import type { Shop } from "@/components/session";
import {
  findByName,
  productHistory,
  saveCash,
  saveExpense,
  saveWriteoff,
  softDelete,
  type CashDay,
  type Directory,
  type Expense,
} from "@/lib/data";
import { formatDayShort } from "@/lib/dates";
import { cashRevenue, formatMoney, formatPrice, lineSum, parseMoney, parseQty, UNIT_LABEL, type Kop } from "@/lib/money";

const moneyStr = (k: number | null | undefined) =>
  k === null || k === undefined ? "" : formatMoney(k, { currency: false }).replace(/ /g, "").replace(/,00$/, "");

/* ───────────── Касса ───────────── */

export function CashSheet({
  shop,
  day,
  cash,
  paidSuppliersCash,
  expensesCash,
  onClose,
  onSaved,
}: {
  shop: Shop;
  day: string;
  cash: CashDay | null;
  paidSuppliersCash: Kop;
  expensesCash: Kop;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [evening, setEvening] = useState(moneyStr(cash?.cash_evening_kop));
  const [terminal, setTerminal] = useState(moneyStr(cash?.terminal_kop));
  const [morning, setMorning] = useState(moneyStr(cash?.cash_morning_kop));
  const [fromCard, setFromCard] = useState(moneyStr(cash?.from_card_kop || null));
  const [taken, setTaken] = useState(moneyStr(cash?.taken_by_owner_kop || null));
  const [comment, setComment] = useState(cash?.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const [termRef, focusTerm] = useFocusRef();
  const [cardRef, focusCard] = useFocusRef();
  const [takenRef, focusTaken] = useFocusRef();
  const [mornRef, focusMorn] = useFocusRef();

  const ev = parseMoney(evening);
  const te = parseMoney(terminal);
  const mo = morning.trim() ? parseMoney(morning) : 0;
  const fc = parseMoney(fromCard) ?? 0;
  const tk = parseMoney(taken) ?? 0;
  const rev =
    ev !== null
      ? cashRevenue({
          cashEvening: ev,
          cashMorning: mo ?? 0,
          terminal: te ?? 0,
          fromCard: fc,
          takenByOwner: tk,
          paidSuppliersCash,
          expensesCash,
        })
      : null;

  function save() {
    setError(null);
    if (ev === null) return setError("Введите, сколько наличных в кассе сейчас (пересчитайте).");
    if (te === null) return setError("Введите сумму по терминалу за день (если терминала не было — 0).");
    if (morning.trim() && parseMoney(morning) === null) return setError("Проверьте сумму «утром в кассе».");
    saveCash(shop.id, day, {
      cash_evening_kop: ev,
      terminal_kop: te,
      // каждый день считается отдельно: если размен не указан — утром было 0
      cash_morning_kop: morning.trim() ? parseMoney(morning) : 0,
      from_card_kop: fc,
      taken_by_owner_kop: tk,
      comment: comment.trim() || null,
    });
    onSaved();
    onClose();
  }

  return (
    <Sheet title={`Касса за ${formatDayShort(day)}`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <NumField label="Наличные в кассе сейчас (пересчёт)" value={evening} onChange={setEvening} suffix="₴" autoFocus onEnter={focusTerm} />
        <NumField label="Терминал за день" value={terminal} onChange={setTerminal} suffix="₴" inputRef={termRef} onEnter={focusCard} />
        <NumField label="Снял с карты и положил в кассу" value={fromCard} onChange={setFromCard} suffix="₴" placeholder="0" inputRef={cardRef} onEnter={focusTaken} />
        <NumField label="Забрал из кассы себе" value={taken} onChange={setTaken} suffix="₴" placeholder="0" inputRef={takenRef} onEnter={focusMorn} />
        <NumField
          label="Утром в кассе было (размен)"
          value={morning}
          onChange={setMorning}
          suffix="₴"
          inputRef={mornRef}
          enterKeyHint="done"
          onEnter={save}
          placeholder="0"
          hint={<span className="text-muted">Если утром ящик пустой — оставьте пустым.</span>}
        />
        <label className="field">
          <span>Комментарий (необязательно)</span>
          <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>

        <div className="card num">
          {paidSuppliersCash > 0 && <Row label="Отдано поставщикам из кассы" value={formatMoney(paidSuppliersCash)} />}
          {expensesCash > 0 && <Row label="Расходы из кассы" value={formatMoney(expensesCash)} />}
          <Row label="Выручка наличными" value={rev !== null ? formatMoney(rev) : "—"} strong />
          <Row label="Выручка всего (+ терминал)" value={rev !== null ? formatMoney(rev + (te ?? 0)) : "—"} strong />
          {rev !== null && rev < 0 && (
            <p className="mt-2 text-sm text-bad">
              Выручка получилась отрицательной — проверьте суммы «утром», «снял с карты» и наличные.
            </p>
          )}
        </div>
        {error && <p className="alert alert-error">{error}</p>}
        <button className="btn btn-primary sticky bottom-2">Сохранить кассу</button>
      </form>
    </Sheet>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <span className="text-muted">{label}</span>
      <span className={strong ? "font-bold" : "font-semibold"}>{value}</span>
    </div>
  );
}

/* ───────────── Расход ───────────── */

const EXPENSE_CATS = ["Пакеты", "Транспорт", "Зарплата", "Аренда", "Свет", "Хозтовары", "Прочее"];

export function ExpenseSheet({
  shop,
  day,
  editing,
  canDelete,
  onClose,
  onSaved,
}: {
  shop: Shop;
  day: string;
  editing: Expense | null;
  canDelete: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState(editing?.category ?? "Пакеты");
  const [amount, setAmount] = useState(moneyStr(editing?.amount_kop));
  const [fromRegister, setFromRegister] = useState(editing?.from_register ?? true);
  const [comment, setComment] = useState(editing?.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  function save() {
    const a = parseMoney(amount);
    if (!a || a <= 0) return setError("Введите сумму расхода.");
    saveExpense(shop.id, { id: editing?.id, day, category, amount_kop: a, from_register: fromRegister, comment: comment.trim() });
    onSaved();
    onClose();
  }

  return (
    <Sheet title={editing ? "Изменить расход" : "Новый расход"} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="field">
          <span>Категория</span>
          <div className="flex flex-wrap gap-2">
            {EXPENSE_CATS.map((c) => (
              <button
                key={c}
                type="button"
                className={`min-h-11 rounded-full border px-4 font-semibold ${
                  category === c ? "border-transparent bg-primary text-[var(--primary-fg)]" : "border-line bg-card text-fg"
                }`}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <NumField label="Сумма" value={amount} onChange={setAmount} suffix="₴" autoFocus={!editing} enterKeyHint="done" onEnter={save} />
        <Segmented
          label="Откуда деньги"
          value={fromRegister ? "reg" : "other"}
          onChange={(v) => setFromRegister(v === "reg")}
          options={[
            { value: "reg", label: "Из кассы" },
            { value: "other", label: "Не из кассы" },
          ]}
        />
        <label className="field">
          <span>Комментарий (необязательно)</span>
          <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        {error && <p className="alert alert-error">{error}</p>}
        <button className="btn btn-primary">Сохранить</button>
        {editing && canDelete && !confirm && (
          <button type="button" className="btn text-bad" onClick={() => setConfirm(true)}>
            Удалить расход
          </button>
        )}
        {editing && confirm && (
          <ConfirmBar
            text="Удалить этот расход? Его можно восстановить из корзины 30 дней."
            onCancel={() => setConfirm(false)}
            onConfirm={() => {
              softDelete("expenses", editing.id);
              onSaved();
              onClose();
            }}
          />
        )}
      </form>
    </Sheet>
  );
}

/* ───────────── Списание ───────────── */

export function WriteoffSheet({
  shop,
  day,
  dir,
  seesCosts,
  onClose,
  onSaved,
}: {
  shop: Shop;
  day: string;
  dir: Directory;
  seesCosts: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [qtyRef, focusQty] = useFocusRef();

  const product = findByName(dir.products, name);
  const q = parseQty(qty);
  const last = product ? productHistory(dir, product.id).find((h) => h.day <= day) : undefined;
  const est = seesCosts && last && q ? lineSum(q, last.buy_price_kop) : null;

  function save() {
    if (!product) return setError("Выберите товар из списка (списать можно только то, что закупали).");
    if (!q || q <= 0) return setError("Введите количество.");
    saveWriteoff(shop.id, { day, product, qty: q, reason: reason.trim(), estSum: est });
    onSaved();
    onClose();
  }

  return (
    <Sheet title="Списание" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <SuggestField
          label="Товар"
          value={name}
          onChange={setName}
          items={dir.products}
          onPick={(p) => setName(p.name)}
          onEnter={focusQty}
          autoFocus
        />
        <NumField
          label={`Количество${product ? `, ${UNIT_LABEL[product.unit]}` : ""}`}
          value={qty}
          onChange={setQty}
          inputRef={qtyRef}
          suffix={product ? UNIT_LABEL[product.unit] : undefined}
          enterKeyHint="done"
          onEnter={save}
        />
        <label className="field">
          <span>Причина</span>
          <input type="text" value={reason} placeholder="Испортился, усушка…" onChange={(e) => setReason(e.target.value)} />
        </label>
        {seesCosts && (
          <p className="text-muted">
            {last
              ? `По цене закупки ${formatPrice(last.buy_price_kop)} ₴: ${est !== null ? formatMoney(est) : "—"}`
              : product
                ? "Закупок этого товара не найдено — сумму посчитает сервер."
                : ""}
          </p>
        )}
        {error && <p className="alert alert-error">{error}</p>}
        <button className="btn btn-primary">Списать</button>
      </form>
    </Sheet>
  );
}
