"use client";

/**
 * Чтение и запись данных магазина. Запись идёт через очередь (queue.ts),
 * поэтому работает и без связи. Чтение кэшируется в телефоне, чтобы экран
 * открывался офлайн.
 */
import { addDays } from "./dates";
import { humanError } from "./errors";
import { lineSum, milliFromNumber, priceFromSum, type Kop, type Milli, type Unit } from "./money";
import { enqueue, newId, pendingOps } from "./queue";
import { supabase } from "./supabase";

export type PaySource = "cash_register" | "own" | "card";
export const PAY_LABEL: Record<PaySource, string> = {
  cash_register: "Нал из кассы",
  own: "Свои",
  card: "Карта",
};

export type Product = {
  id: string;
  name: string;
  unit: Unit;
  category_id: string | null;
  target_markup_pct: number | null;
};
export type Supplier = { id: string; name: string };
export type Category = { id: string; name: string; target_markup_pct: number | null };

export type Purchase = {
  id: string;
  day: string;
  product_id: string;
  product_name: string;
  supplier_id: string | null;
  supplier_name: string | null;
  qty: Milli;
  unit: Unit;
  buy_input: "price" | "sum";
  /** null — скрыто от продавца */
  buy_price_kop: Kop | null;
  buy_sum_kop: Kop | null;
  sell_price_kop: Kop;
  sell_sum_kop: Kop;
  pay_source: PaySource;
  /** для продавца: сколько отдано из кассы */
  paid_cash_kop: Kop;
  comment: string | null;
  position: number;
  created_at: string;
  pending?: boolean;
};

export type CashDay = {
  cash_evening_kop: Kop | null;
  terminal_kop: Kop | null;
  cash_morning_kop: Kop | null;
  from_card_kop: Kop;
  taken_by_owner_kop: Kop;
  comment: string | null;
};

export type Expense = {
  id: string;
  day: string;
  category: string;
  amount_kop: Kop;
  from_register: boolean;
  comment: string | null;
  created_at: string;
  pending?: boolean;
};

export type Writeoff = {
  id: string;
  day: string;
  product_id: string;
  product_name: string;
  qty: Milli;
  sum_kop: Kop | null;
  reason: string | null;
  created_at: string;
  pending?: boolean;
};

export type HistoryRow = {
  product_id: string;
  day: string;
  qty: Milli;
  unit: Unit;
  buy_price_kop: Kop;
  sell_price_kop: Kop;
};

export type DayData = {
  purchases: Purchase[];
  cash: CashDay | null;
  /** вечерние наличные предыдущего дня с кассой */
  prevEvening: Kop | null;
  expenses: Expense[];
  writeoffs: Writeoff[];
};

export type Directory = {
  products: Product[];
  suppliers: Supplier[];
  categories: Category[];
  /** закупки за последние ~4 месяца (только владельцу/наблюдателю) */
  history: HistoryRow[];
};

/* ───────────── преобразования ───────────── */

/** Миллидоли → строка для numeric в базе («20.200»), без float. */
export function qtyToDb(q: Milli): string {
  return `${Math.floor(q / 1000)}.${String(q % 1000).padStart(3, "0")}`;
}
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const kop = (v: unknown): Kop => Math.round(num(v));

/* ───────────── кэш для офлайна ───────────── */

function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`kassa-cache:${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function cacheSet(key: string, v: unknown) {
  try {
    localStorage.setItem(`kassa-cache:${key}`, JSON.stringify(v));
  } catch {}
}

/* ───────────── наложение неотправленных изменений ───────────── */

function overlay<T extends { id: string }>(
  table: string,
  rows: T[],
  accept: (row: Record<string, unknown>) => boolean,
  fromQueued: (row: Record<string, unknown>, display: Record<string, unknown>) => T,
): T[] {
  let out = [...rows];
  for (const op of pendingOps()) {
    if (op.kind === "insert" && op.table === table && accept(op.row)) {
      if (!out.some((r) => r.id === op.row.id))
        out.push({ ...fromQueued(op.row, op.display ?? {}), pending: true });
    } else if (op.kind === "update" && op.table === table) {
      out = out.map((r) => (r.id === op.id ? { ...r, ...patchToLocal(op.patch), pending: true } : r));
      if ("deleted_at" in op.patch && op.patch.deleted_at) out = out.filter((r) => r.id !== op.id);
    }
  }
  return out;
}

function patchToLocal(p: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...p };
  if (typeof o.qty === "string") o.qty = milliFromNumber(Number(o.qty));
  return o;
}

/* ───────────── загрузка ───────────── */

export async function loadDirectory(shopId: string, seesCosts: boolean, today: string): Promise<Directory> {
  const sb = supabase();
  const key = `dir:${shopId}`;
  try {
    const [p, s, c, h] = await Promise.all([
      sb.from("products").select("id,name,unit,category_id,target_markup_pct").eq("shop_id", shopId).is("deleted_at", null).order("name"),
      sb.from("suppliers").select("id,name").eq("shop_id", shopId).is("deleted_at", null).order("name"),
      sb.from("categories").select("id,name,target_markup_pct").eq("shop_id", shopId).is("deleted_at", null).order("sort"),
      seesCosts
        ? sb
            .from("purchases")
            .select("product_id,day,qty,unit,buy_price_kop,sell_price_kop,created_at")
            .eq("shop_id", shopId)
            .is("deleted_at", null)
            .gte("day", addDays(today, -120))
            .order("day", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(3000)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const err = p.error ?? s.error ?? c.error ?? h.error;
    if (err) throw err;
    const dir: Directory = {
      products: (p.data ?? []).map((r) => ({ ...r, target_markup_pct: r.target_markup_pct === null ? null : num(r.target_markup_pct) })) as Product[],
      suppliers: (s.data ?? []) as Supplier[],
      categories: (c.data ?? []).map((r) => ({ ...r, target_markup_pct: r.target_markup_pct === null ? null : num(r.target_markup_pct) })) as Category[],
      history: ((h.data ?? []) as Record<string, unknown>[]).map((r) => ({
        product_id: String(r.product_id),
        day: String(r.day),
        qty: milliFromNumber(num(r.qty)),
        unit: r.unit as Unit,
        buy_price_kop: kop(r.buy_price_kop),
        sell_price_kop: kop(r.sell_price_kop),
      })),
    };
    cacheSet(key, dir);
    return withPendingDirectory(dir);
  } catch (e) {
    const cached = cacheGet<Directory>(key);
    if (cached) return withPendingDirectory(cached);
    throw new Error(humanError(e));
  }
}

function withPendingDirectory(d: Directory): Directory {
  const products = [...d.products];
  const suppliers = [...d.suppliers];
  for (const op of pendingOps()) {
    if (op.kind !== "insert") continue;
    if (op.table === "products" && !products.some((p) => p.id === op.row.id))
      products.push({
        id: String(op.row.id),
        name: String(op.row.name),
        unit: op.row.unit as Unit,
        category_id: null,
        target_markup_pct: null,
      });
    if (op.table === "suppliers" && !suppliers.some((p) => p.id === op.row.id))
      suppliers.push({ id: String(op.row.id), name: String(op.row.name) });
  }
  return { ...d, products, suppliers };
}

export async function loadDay(
  shopId: string,
  day: string,
  seesCosts: boolean,
  localOnly = false,
): Promise<DayData & { offline: boolean }> {
  const sb = supabase();
  const key = `day:${shopId}:${day}`;
  let data: DayData;
  let offline = false;
  try {
    if (localOnly) throw new Error("local");
    const purchasesQ = seesCosts
      ? sb
          .from("purchases")
          .select("id,day,product_id,supplier_id,qty,unit,buy_input,buy_price_kop,buy_sum_kop,sell_price_kop,sell_sum_kop,pay_source,comment,position,created_at,products(name),suppliers(name)")
          .eq("shop_id", shopId)
          .eq("day", day)
          .is("deleted_at", null)
          .order("position")
          .order("created_at")
      : sb.rpc("seller_purchases", { p_shop: shopId, p_day: day });
    const writeoffsQ = seesCosts
      ? sb
          .from("writeoffs")
          .select("id,day,product_id,qty,sum_kop,reason,created_at,products(name)")
          .eq("shop_id", shopId)
          .eq("day", day)
          .is("deleted_at", null)
          .order("created_at")
      : sb.rpc("seller_writeoffs", { p_shop: shopId, p_day: day });
    const [pu, ca, prev, ex, wo] = await Promise.all([
      purchasesQ,
      sb.from("cash_days").select("cash_evening_kop,terminal_kop,cash_morning_kop,from_card_kop,taken_by_owner_kop,comment").eq("shop_id", shopId).eq("day", day).maybeSingle(),
      sb
        .from("cash_days")
        .select("cash_evening_kop")
        .eq("shop_id", shopId)
        .lt("day", day)
        .not("cash_evening_kop", "is", null)
        .order("day", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb.from("expenses").select("id,day,category,amount_kop,from_register,comment,created_at").eq("shop_id", shopId).eq("day", day).is("deleted_at", null).order("created_at"),
      writeoffsQ,
    ]);
    const err = pu.error ?? ca.error ?? prev.error ?? ex.error ?? wo.error;
    if (err) throw err;

    type R = Record<string, unknown>;
    const purchases: Purchase[] = ((pu.data ?? []) as R[]).map((r) => {
      const buySum = r.buy_sum_kop === undefined ? null : kop(r.buy_sum_kop);
      return {
        id: String(r.id),
        day,
        product_id: String(r.product_id),
        product_name: String((r.products as R | null)?.name ?? r.product_name ?? "?"),
        supplier_id: (r.supplier_id as string | null) ?? null,
        supplier_name: ((r.suppliers as R | null)?.name ?? r.supplier_name ?? null) as string | null,
        qty: milliFromNumber(num(r.qty)),
        unit: r.unit as Unit,
        buy_input: (r.buy_input as "price" | "sum") ?? "price",
        buy_price_kop: r.buy_price_kop === undefined ? null : kop(r.buy_price_kop),
        buy_sum_kop: buySum,
        sell_price_kop: kop(r.sell_price_kop),
        sell_sum_kop: r.sell_sum_kop === undefined ? lineSum(milliFromNumber(num(r.qty)), kop(r.sell_price_kop)) : kop(r.sell_sum_kop),
        pay_source: r.pay_source as PaySource,
        paid_cash_kop: r.paid_cash_kop !== undefined ? kop(r.paid_cash_kop) : r.pay_source === "cash_register" ? (buySum ?? 0) : 0,
        comment: (r.comment as string | null) ?? null,
        position: num(r.position ?? 0),
        created_at: String(r.created_at),
      };
    });
    const c = ca.data as R | null;
    data = {
      purchases,
      cash: c
        ? {
            cash_evening_kop: c.cash_evening_kop === null ? null : kop(c.cash_evening_kop),
            terminal_kop: c.terminal_kop === null ? null : kop(c.terminal_kop),
            cash_morning_kop: c.cash_morning_kop === null ? null : kop(c.cash_morning_kop),
            from_card_kop: kop(c.from_card_kop),
            taken_by_owner_kop: kop(c.taken_by_owner_kop),
            comment: (c.comment as string | null) ?? null,
          }
        : null,
      prevEvening: prev.data ? kop((prev.data as R).cash_evening_kop) : null,
      expenses: ((ex.data ?? []) as R[]).map((r) => ({
        id: String(r.id),
        day,
        category: String(r.category),
        amount_kop: kop(r.amount_kop),
        from_register: Boolean(r.from_register),
        comment: (r.comment as string | null) ?? null,
        created_at: String(r.created_at),
      })),
      writeoffs: ((wo.data ?? []) as R[]).map((r) => ({
        id: String(r.id),
        day,
        product_id: String(r.product_id),
        product_name: String((r.products as R | null)?.name ?? r.product_name ?? "?"),
        qty: milliFromNumber(num(r.qty)),
        sum_kop: r.sum_kop === undefined ? null : kop(r.sum_kop),
        reason: (r.reason as string | null) ?? null,
        created_at: String(r.created_at),
      })),
    };
    cacheSet(key, data);
  } catch (e) {
    const cached = cacheGet<DayData>(key);
    if (!cached && localOnly) return loadDay(shopId, day, seesCosts, false);
    if (!cached) throw new Error(humanError(e));
    data = cached;
    offline = !localOnly;
  }
  return { ...withPendingDay(data, day), offline };
}

function withPendingDay(d: DayData, day: string): DayData {
  const onDay = (r: Record<string, unknown>) => r.day === day;
  const purchases = overlay<Purchase>("purchases", d.purchases, onDay, (r, disp) => purchaseFromRow(r, disp));
  // закупки продавца уходят через rpc — показываем и их
  for (const op of pendingOps()) {
    if (op.kind === "rpc" && op.fn === "add_purchase_seller" && op.args.p_day === day && !purchases.some((p) => p.id === op.args.p_id)) {
      const a = op.args;
      purchases.push({
        ...purchaseFromRow(
          {
            id: a.p_id, day, product_id: a.p_product, supplier_id: a.p_supplier, qty: a.p_qty, unit: a.p_unit,
            buy_input: a.p_buy_input, buy_price_kop: a.p_buy_price_kop, buy_sum_kop: a.p_buy_sum_kop,
            sell_price_kop: a.p_sell_price_kop, pay_source: a.p_pay_source, comment: a.p_comment,
          },
          op.display ?? {},
        ),
        buy_price_kop: null,
        buy_sum_kop: null,
        pending: true,
      });
    }
  }
  let cash = d.cash;
  for (const op of pendingOps()) {
    if (op.kind === "upsert" && op.table === "cash_days" && op.row.day === day) {
      const r = op.row;
      cash = {
        cash_evening_kop: (r.cash_evening_kop as Kop | null) ?? null,
        terminal_kop: (r.terminal_kop as Kop | null) ?? null,
        cash_morning_kop: (r.cash_morning_kop as Kop | null) ?? null,
        from_card_kop: (r.from_card_kop as Kop) ?? 0,
        taken_by_owner_kop: (r.taken_by_owner_kop as Kop) ?? 0,
        comment: (r.comment as string | null) ?? null,
      };
    }
  }
  const expenses = overlay<Expense>("expenses", d.expenses, onDay, (r) => ({
    id: String(r.id),
    day,
    category: String(r.category),
    amount_kop: r.amount_kop as Kop,
    from_register: Boolean(r.from_register),
    comment: (r.comment as string | null) ?? null,
    created_at: new Date().toISOString(),
  }));
  const writeoffs = overlay<Writeoff>("writeoffs", d.writeoffs, onDay, (r, disp) => ({
    id: String(r.id),
    day,
    product_id: String(r.product_id),
    product_name: String(disp.product_name ?? "?"),
    qty: milliFromNumber(Number(r.qty)),
    sum_kop: (disp.sum_kop as Kop | undefined) ?? null,
    reason: (r.reason as string | null) ?? null,
    created_at: new Date().toISOString(),
  }));
  return { ...d, purchases, cash, expenses, writeoffs };
}

function purchaseFromRow(r: Record<string, unknown>, disp: Record<string, unknown>): Purchase {
  const qty = milliFromNumber(Number(r.qty));
  const buyInput = (r.buy_input as "price" | "sum") ?? "price";
  const buyPrice = buyInput === "sum" ? priceFromSum(Number(r.buy_sum_kop), qty) : Number(r.buy_price_kop);
  const buySum = buyInput === "sum" ? Number(r.buy_sum_kop) : lineSum(qty, Number(r.buy_price_kop));
  const pay = r.pay_source as PaySource;
  return {
    id: String(r.id),
    day: String(r.day),
    product_id: String(r.product_id),
    product_name: String(disp.product_name ?? "?"),
    supplier_id: (r.supplier_id as string | null) ?? null,
    supplier_name: (disp.supplier_name as string | null) ?? null,
    qty,
    unit: r.unit as Unit,
    buy_input: buyInput,
    buy_price_kop: buyPrice,
    buy_sum_kop: buySum,
    sell_price_kop: Number(r.sell_price_kop),
    sell_sum_kop: lineSum(qty, Number(r.sell_price_kop)),
    pay_source: pay,
    paid_cash_kop: pay === "cash_register" ? buySum : 0,
    comment: (r.comment as string | null) ?? null,
    position: Number(r.position ?? 0),
    created_at: new Date().toISOString(),
  };
}

/* ───────────── запись ───────────── */

export function createProduct(shopId: string, name: string, unit: Unit): Product {
  const p: Product = { id: newId(), name: name.trim(), unit, category_id: null, target_markup_pct: null };
  enqueue({ kind: "insert", table: "products", row: { id: p.id, shop_id: shopId, name: p.name, unit } });
  return p;
}

export function createSupplier(shopId: string, name: string): Supplier {
  const s: Supplier = { id: newId(), name: name.trim() };
  enqueue({ kind: "insert", table: "suppliers", row: { id: s.id, shop_id: shopId, name: s.name } });
  return s;
}

export type PurchaseInput = {
  id?: string;
  day: string;
  product: Product;
  supplier: Supplier | null;
  qty: Milli;
  unit: Unit;
  buyInput: "price" | "sum";
  buyPrice: Kop;
  buySum: Kop;
  sellPrice: Kop;
  paySource: PaySource;
  comment: string;
  position: number;
};

export function savePurchase(shopId: string, p: PurchaseInput, asSeller: boolean): string {
  const id = p.id ?? newId();
  const display = { product_name: p.product.name, supplier_name: p.supplier?.name ?? null };
  if (asSeller) {
    enqueue(
      {
        kind: "rpc",
        fn: "add_purchase_seller",
        args: {
          p_id: id, p_shop: shopId, p_day: p.day, p_product: p.product.id, p_supplier: p.supplier?.id ?? null,
          p_qty: qtyToDb(p.qty), p_unit: p.unit, p_buy_input: p.buyInput,
          p_buy_price_kop: p.buyInput === "price" ? p.buyPrice : null,
          p_buy_sum_kop: p.buyInput === "sum" ? p.buySum : null,
          p_sell_price_kop: p.sellPrice, p_pay_source: p.paySource, p_comment: p.comment || null,
        },
      },
      display,
    );
    return id;
  }
  const fields = {
    day: p.day,
    product_id: p.product.id,
    supplier_id: p.supplier?.id ?? null,
    qty: qtyToDb(p.qty),
    unit: p.unit,
    buy_input: p.buyInput,
    buy_price_kop: p.buyInput === "price" ? p.buyPrice : 0,
    buy_sum_kop: p.buyInput === "sum" ? p.buySum : 0,
    sell_price_kop: p.sellPrice,
    pay_source: p.paySource,
    comment: p.comment || null,
  };
  if (p.id) enqueue({ kind: "update", table: "purchases", id: p.id, patch: fields }, display);
  else enqueue({ kind: "insert", table: "purchases", row: { id, shop_id: shopId, position: p.position, ...fields } }, display);
  return id;
}

export function softDelete(table: "purchases" | "expenses" | "writeoffs" | "customer_debts", id: string) {
  enqueue({ kind: "update", table, id, patch: { deleted_at: new Date().toISOString() } });
}

export function restore(table: "purchases" | "expenses" | "writeoffs" | "customer_debts", id: string) {
  enqueue({ kind: "update", table, id, patch: { deleted_at: null } });
}

export function saveCash(shopId: string, day: string, c: CashDay) {
  enqueue({
    kind: "upsert",
    table: "cash_days",
    onConflict: "shop_id,day",
    row: { shop_id: shopId, day, ...c },
  });
}

export function saveExpense(shopId: string, e: Omit<Expense, "id" | "created_at"> & { id?: string }) {
  const fields = {
    day: e.day,
    category: e.category,
    amount_kop: e.amount_kop,
    from_register: e.from_register,
    comment: e.comment || null,
  };
  if (e.id) enqueue({ kind: "update", table: "expenses", id: e.id, patch: fields });
  else enqueue({ kind: "insert", table: "expenses", row: { id: newId(), shop_id: shopId, ...fields } });
}

export function saveWriteoff(
  shopId: string,
  w: { day: string; product: Product; qty: Milli; reason: string; estSum: Kop | null },
) {
  enqueue(
    {
      kind: "insert",
      table: "writeoffs",
      row: { id: newId(), shop_id: shopId, day: w.day, product_id: w.product.id, qty: qtyToDb(w.qty), reason: w.reason || null },
    },
    { product_name: w.product.name, sum_kop: w.estSum },
  );
}

/* ───────────── помощники ───────────── */

export function findByName<T extends { name: string }>(list: T[], name: string): T | undefined {
  const n = name.trim().toLowerCase();
  return list.find((x) => x.name.toLowerCase() === n);
}

/** Целевая наценка товара: своя → категории → магазина. */
export function targetMarkup(p: Product | undefined, dir: Directory, shopDefault: number): number {
  if (p?.target_markup_pct != null) return p.target_markup_pct;
  const c = p?.category_id ? dir.categories.find((x) => x.id === p.category_id) : undefined;
  if (c?.target_markup_pct != null) return c.target_markup_pct;
  return shopDefault;
}

/** Последние закупки товара (новые первыми). */
export function productHistory(dir: Directory, productId: string): HistoryRow[] {
  return dir.history.filter((h) => h.product_id === productId);
}
