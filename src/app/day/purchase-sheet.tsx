"use client";

import { useEffect, useMemo, useState } from "react";
import { ConfirmBar, NumField, Segmented, Sheet, SuggestField, useFocusRef } from "@/components/ui";
import type { Shop } from "@/components/session";
import { checkPurchase } from "@/lib/checks";
import {
  createProduct,
  createSupplier,
  findByName,
  PAY_LABEL,
  productHistory,
  savePurchase,
  softDelete,
  targetMarkup,
  type Directory,
  type PaySource,
  type Product,
  type Purchase,
} from "@/lib/data";
import {
  formatMoney,
  formatPct,
  formatPrice,
  formatQty,
  lineSum,
  markupPct,
  parseMoney,
  parseQty,
  priceFromSum,
  sellPriceByMarkup,
  UNIT_LABEL,
  type Unit,
} from "@/lib/money";

type Form = {
  name: string;
  qty: string;
  unit: Unit;
  mode: "price" | "sum";
  buyPrice: string;
  buySum: string;
  sell: string;
  sellTouched: boolean;
  supplier: string;
  pay: PaySource;
  comment: string;
};

const EMPTY: Form = {
  name: "",
  qty: "",
  unit: "kg",
  mode: "price",
  buyPrice: "",
  buySum: "",
  sell: "",
  sellTouched: false,
  supplier: "",
  pay: "cash_register",
  comment: "",
};

const priceStr = (k: number) => formatPrice(k).replace(/ /g, "");

function fromPurchase(p: Purchase): Form {
  return {
    name: p.product_name,
    qty: formatQty(p.qty).replace(/ /g, ""),
    unit: p.unit,
    mode: p.buy_input,
    buyPrice: p.buy_price_kop !== null ? priceStr(p.buy_price_kop) : "",
    buySum: p.buy_sum_kop !== null ? formatMoney(p.buy_sum_kop, { currency: false }).replace(/ /g, "") : "",
    sell: priceStr(p.sell_price_kop),
    sellTouched: true,
    supplier: p.supplier_name ?? "",
    pay: p.pay_source,
    comment: p.comment ?? "",
  };
}

function readDraft(key: string): Form | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Form>) } : null;
  } catch {
    return null;
  }
}

export function PurchaseSheet({
  shop,
  day,
  dir,
  dayRows,
  editing,
  asSeller,
  onClose,
  onSaved,
  onDirectoryChange,
}: {
  shop: Shop;
  day: string;
  dir: Directory;
  dayRows: Purchase[];
  editing: Purchase | null;
  asSeller: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDirectoryChange: (d: Directory) => void;
}) {
  const draftKey = `kassa-draft:purchase:${shop.id}:${day}`;
  const [f, setF] = useState<Form>(() => (editing ? fromPurchase(editing) : (readDraft(draftKey) ?? EMPTY)));
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [nameRef, focusName] = useFocusRef();
  const [qtyRef, focusQty] = useFocusRef();
  const [buyRef, focusBuy] = useFocusRef();
  const [sellRef, focusSell] = useFocusRef();
  const [supRef, focusSup] = useFocusRef();

  // черновик новой позиции не теряется при закрытии/перезагрузке
  useEffect(() => {
    if (editing) return;
    try {
      if (f.name || f.qty || f.buyPrice || f.buySum) localStorage.setItem(draftKey, JSON.stringify(f));
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [f, editing, draftKey]);

  const product = findByName(dir.products, f.name);
  const history = useMemo(
    () => (product ? productHistory(dir, product.id).filter((h) => h.day < day) : []),
    [dir, product, day],
  );
  const markup = targetMarkup(product, dir, shop.default_markup_pct);

  const qty = parseQty(f.qty);
  const buyPrice =
    f.mode === "price" ? parseMoney(f.buyPrice) : qty && parseMoney(f.buySum) !== null ? priceFromSum(parseMoney(f.buySum)!, qty) : null;
  const buySum = f.mode === "sum" ? parseMoney(f.buySum) : qty !== null && buyPrice !== null ? lineSum(qty, buyPrice) : null;
  const sell = parseMoney(f.sell);
  const sellSum = qty !== null && sell !== null ? lineSum(qty, sell) : null;
  const autoSell = buyPrice !== null && buyPrice > 0 ? sellPriceByMarkup(buyPrice, markup, shop.price_round_kop) : null;

  // цена продажи по наценке, пока её не правили руками
  function withAutoSell(next: Form): Form {
    if (next.sellTouched) return next;
    const q = parseQty(next.qty);
    const bp =
      next.mode === "price"
        ? parseMoney(next.buyPrice)
        : q && parseMoney(next.buySum) !== null
          ? priceFromSum(parseMoney(next.buySum)!, q)
          : null;
    const p = findByName(dir.products, next.name);
    const m = targetMarkup(p, dir, shop.default_markup_pct);
    return { ...next, sell: bp && bp > 0 ? priceStr(sellPriceByMarkup(bp, m, shop.price_round_kop)) : "" };
  }
  const set = (patch: Partial<Form>) => setF((cur) => withAutoSell({ ...cur, ...patch }));

  function pickProduct(p: Product) {
    const h = productHistory(dir, p.id);
    const last = h.find((x) => x.unit === p.unit) ?? h[0];
    setF((cur) =>
      withAutoSell({
        ...cur,
        name: p.name,
        unit: p.unit,
        buyPrice: cur.buyPrice || (last && cur.mode === "price" && !asSeller ? priceStr(last.buy_price_kop) : cur.buyPrice),
      }),
    );
  }

  const warnings =
    f.name.trim() && qty && buyPrice
      ? checkPurchase({
          name: f.name.trim(),
          qty: qty ?? 0,
          unit: f.unit,
          buyPrice: buyPrice ?? 0,
          sellPrice: sell ?? 0,
          history: history.map((h) => ({ qty: h.qty, unit: h.unit, buyPrice: h.buy_price_kop })),
          sameDay: dayRows
            .filter((r) => r.id !== editing?.id && r.buy_price_kop !== null)
            .map((r) => ({ name: r.product_name, qty: r.qty, buyPrice: r.buy_price_kop!, sellPrice: r.sell_price_kop })),
          lowMarkupPct: shop.low_markup_pct,
          priceJumpPct: shop.price_jump_pct,
        })
      : [];

  function save(next: boolean) {
    setError(null);
    const name = f.name.trim();
    if (!name) return setError("Введите название товара."), focusName();
    if (!qty || qty <= 0) return setError("Введите количество больше нуля."), focusQty();
    if (buyPrice === null || buySum === null || buyPrice <= 0)
      return setError(f.mode === "price" ? "Введите цену закупки за единицу." : "Введите, сколько всего отдали поставщику."), focusBuy();
    if (sell === null || sell <= 0) return setError("Введите цену продажи."), focusSell();

    let d = dir;
    let prod = findByName(d.products, name);
    if (!prod) {
      prod = createProduct(shop.id, name, f.unit);
      d = { ...d, products: [...d.products, prod] };
    }
    let sup = f.supplier.trim() ? findByName(d.suppliers, f.supplier) : null;
    if (f.supplier.trim() && !sup) {
      sup = createSupplier(shop.id, f.supplier);
      d = { ...d, suppliers: [...d.suppliers, sup] };
    }
    if (d !== dir) onDirectoryChange(d);

    savePurchase(
      shop.id,
      {
        id: editing?.id,
        day,
        product: prod,
        supplier: sup ?? null,
        qty,
        unit: f.unit,
        buyInput: f.mode,
        buyPrice,
        buySum,
        sellPrice: sell,
        paySource: f.pay,
        comment: f.comment.trim(),
        position: editing?.position ?? dayRows.length + 1,
      },
      asSeller,
    );
    onSaved();
    if (next && !editing) {
      setF({ ...EMPTY, supplier: f.supplier, pay: f.pay });
      setSavedCount((n) => n + 1);
      setTimeout(focusName, 50);
    } else {
      try {
        localStorage.removeItem(draftKey);
      } catch {}
      onClose();
    }
  }

  const m = buyPrice && sell ? markupPct(buyPrice, sell) : null;
  const lowMarkup = m !== null && m < shop.low_markup_pct;

  return (
    <Sheet title={editing ? "Изменить позицию" : "Новая позиция"} onClose={onClose}>
      {savedCount > 0 && (
        <p className="alert mb-3 bg-card text-good">
          ✓ Сохранено позиций: {savedCount}. Вводите следующую.
        </p>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save(true);
        }}
      >
        <SuggestField
          label="Товар"
          value={f.name}
          onChange={(v) => set({ name: v })}
          items={dir.products}
          onPick={pickProduct}
          inputRef={nameRef}
          onEnter={focusQty}
          autoFocus={!editing}
          placeholder="Например: Картофель"
          renderMeta={(p) => {
            const last = productHistory(dir, p.id)[0];
            return last && !asSeller ? `${formatPrice(last.buy_price_kop)} → ${formatPrice(last.sell_price_kop)}` : UNIT_LABEL[p.unit];
          }}
        />

        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <NumField
            label="Количество"
            value={f.qty}
            onChange={(v) => set({ qty: v })}
            inputRef={qtyRef}
            onEnter={focusBuy}
            suffix={UNIT_LABEL[f.unit]}
          />
          <Segmented
            value={f.unit}
            onChange={(u) => set({ unit: u })}
            options={[
              { value: "kg", label: "кг" },
              { value: "pcs", label: "шт" },
            ]}
          />
        </div>

        <Segmented
          label="Закупка"
          value={f.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "price", label: `Цена за ${UNIT_LABEL[f.unit]}` },
            { value: "sum", label: "Сумма за всё" },
          ]}
        />
        {f.mode === "price" ? (
          <NumField
            label={`Цена закупки за ${UNIT_LABEL[f.unit]}`}
            value={f.buyPrice}
            onChange={(v) => set({ buyPrice: v })}
            inputRef={buyRef}
            onEnter={focusSell}
            suffix="₴"
            hint={
              history[0] && !asSeller ? (
                <span className="text-muted">Прошлая цена: {formatPrice(history[0].buy_price_kop)} ₴ ({history[0].day.slice(8, 10)}.{history[0].day.slice(5, 7)})</span>
              ) : undefined
            }
          />
        ) : (
          <NumField
            label="Сколько всего отдали поставщику"
            value={f.buySum}
            onChange={(v) => set({ buySum: v })}
            inputRef={buyRef}
            onEnter={focusSell}
            suffix="₴"
            hint={
              buyPrice !== null ? (
                <span className="text-muted">
                  Цена за {UNIT_LABEL[f.unit]}: <b className="num text-fg">{formatPrice(buyPrice)} ₴</b>
                </span>
              ) : undefined
            }
          />
        )}

        <NumField
          label={`Цена продажи за ${UNIT_LABEL[f.unit]}`}
          value={f.sell}
          onChange={(v) => setF((cur) => ({ ...cur, sell: v, sellTouched: true }))}
          inputRef={sellRef}
          onEnter={focusSup}
          suffix="₴"
          hint={
            autoSell !== null ? (
              <span className="text-muted">
                По наценке {formatPct(markup, 0)}: {formatPrice(autoSell)} ₴
                {f.sellTouched && autoSell !== sell && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() => setF((cur) => ({ ...cur, sell: priceStr(autoSell), sellTouched: false }))}
                    >
                      подставить
                    </button>
                  </>
                )}
              </span>
            ) : undefined
          }
        />

        <SuggestField
          label="Поставщик (необязательно)"
          value={f.supplier}
          onChange={(v) => setF((cur) => ({ ...cur, supplier: v }))}
          items={dir.suppliers}
          onPick={(s) => setF((cur) => ({ ...cur, supplier: s.name }))}
          inputRef={supRef}
          placeholder="Например: Рынок, Иван"
        />

        <Segmented
          label="Оплата поставщику"
          value={f.pay}
          onChange={(pay) => setF((cur) => ({ ...cur, pay }))}
          options={(Object.keys(PAY_LABEL) as PaySource[]).map((v) => ({ value: v, label: PAY_LABEL[v] }))}
        />

        <label className="field">
          <span>Комментарий (необязательно)</span>
          <input type="text" value={f.comment} onChange={(e) => setF((cur) => ({ ...cur, comment: e.target.value }))} />
        </label>

        {/* итог строки */}
        <div className={`card num ${lowMarkup ? "!border-warn" : ""}`}>
          <Line label="Сумма закупки" value={buySum !== null ? formatMoney(buySum) : "—"} />
          <Line label="Сумма прихода" value={sellSum !== null ? formatMoney(sellSum) : "—"} />
          <Line
            label="Заработок"
            value={buySum !== null && sellSum !== null ? formatMoney(sellSum - buySum) : "—"}
            strong
          />
          <Line label="Наценка" value={formatPct(m)} className={lowMarkup ? "text-warn" : ""} />
        </div>

        {warnings.map((w, i) => (
          <p key={i} className={`alert ${w.level === "bad" ? "alert-error" : "alert-warn"}`}>
            ⚠ {w.text}
          </p>
        ))}
        {error && <p className="alert alert-error">{error}</p>}

        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 bg-bg px-4 pb-2 pt-2">
          {editing ? (
            <button type="button" className="btn btn-primary" onClick={() => save(false)}>
              Сохранить изменения
            </button>
          ) : (
            <div className="flex gap-2">
              <button type="button" className="btn flex-1 !px-2" onClick={() => save(false)}>
                Сохранить
              </button>
              <button type="submit" className="btn btn-primary flex-[1.6] !px-2">
                Сохранить, далее →
              </button>
            </div>
          )}
          {editing && !asSeller && !confirmDelete && (
            <button type="button" className="btn text-bad" onClick={() => setConfirmDelete(true)}>
              Удалить позицию
            </button>
          )}
          {editing && confirmDelete && (
            <ConfirmBar
              text={`Удалить «${editing.product_name}»? Позиция попадёт в корзину, её можно восстановить 30 дней.`}
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => {
                softDelete("purchases", editing.id);
                onSaved();
                onClose();
              }}
            />
          )}
        </div>
      </form>
    </Sheet>
  );
}

function Line({ label, value, strong, className = "" }: { label: string; value: string; strong?: boolean; className?: string }) {
  return (
    <div className={`flex justify-between py-0.5 ${className}`}>
      <span className="text-muted">{label}</span>
      <span className={strong ? "text-lg font-bold text-good" : "font-semibold"}>{value}</span>
    </div>
  );
}
