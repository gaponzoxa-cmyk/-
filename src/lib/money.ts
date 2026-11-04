/**
 * Все денежные расчёты приложения.
 *
 * Правила (одинаковые здесь и в базе данных, см. supabase/migrations):
 *  - деньги — целые копейки (number, без дробной части);
 *  - количество — целые тысячные доли (граммы для кг, 0,001 шт для шт),
 *    в базе это numeric(10,3);
 *  - сумма строки = кол-во × цена, округление до копейки «половина вверх»
 *    (так же работает round() для numeric в Postgres);
 *  - никаких float в расчётах денег.
 */

export type Kop = number; // копейки
export type Milli = number; // количество × 1000

export type Unit = "kg" | "pcs";

export const UNIT_LABEL: Record<Unit, string> = { kg: "кг", pcs: "шт" };

function assertInt(n: number, what: string) {
  if (!Number.isSafeInteger(n)) throw new Error(`${what}: ожидалось целое число, получено ${n}`);
}

/** Деление неотрицательных целых с округлением «половина вверх». */
export function divRoundHalfUp(a: number, b: number): number {
  assertInt(a, "делимое");
  assertInt(b, "делитель");
  if (b <= 0) throw new Error("делитель должен быть > 0");
  if (a < 0) return -divRoundHalfUp(-a, b);
  return Math.floor((2 * a + b) / (2 * b));
}

/** Сумма строки: кол-во × цена за единицу. */
export function lineSum(qty: Milli, price: Kop): Kop {
  return divRoundHalfUp(qty * price, 1000);
}

/** Цена за единицу из общей суммы (ввод «отдал поставщику X ₴ за Y кг»). */
export function priceFromSum(sum: Kop, qty: Milli): Kop {
  if (qty <= 0) throw new Error("Количество должно быть больше нуля");
  return divRoundHalfUp(sum * 1000, qty);
}

/**
 * Цена продажи по наценке, округлённая ВВЕРХ до шага (по умолчанию 1 ₴).
 * markupPct может быть дробным (32,5 %) — переводим в сотые доли процента.
 */
export function sellPriceByMarkup(buy: Kop, markupPct: number, stepKop: Kop = 100): Kop {
  assertInt(buy, "цена закупки");
  assertInt(stepKop, "шаг округления");
  const bp = Math.round(markupPct * 100); // сотые доли процента
  const num = buy * (10000 + bp);
  const den = 10000 * stepKop;
  return ceilDiv(num, den) * stepKop;
}

function ceilDiv(a: number, b: number) {
  return Math.floor((a + b - 1) / b);
}

/** Наценка в % к цене закупки (для отображения; может быть дробной). */
export function markupPct(buy: Kop, sell: Kop): number | null {
  if (buy <= 0) return null;
  return ((sell - buy) * 100) / buy;
}

/* ───────────── Разбор ввода ───────────── */

/**
 * Разбирает строку с числом в целое количество «долей» (scale знаков после запятой).
 * Принимает «71,8», «71.8», «1 450,36», «  12 ». Возвращает null, если ввод неверный.
 */
export function parseDecimal(input: string, scale: number): number | null {
  const s = input.replace(/[\s ₴]/g, "").replace(",", ".");
  if (s === "") return null;
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const intPart = m[1];
  const frac = m[2] ?? "";
  if (frac.length > scale) {
    // лишние знаки — округляем половина вверх
    const kept = frac.slice(0, scale);
    const next = Number(frac[scale]);
    const base = Number(intPart + kept.padEnd(scale, "0"));
    return next >= 5 ? base + 1 : base;
  }
  const v = Number(intPart + frac.padEnd(scale, "0"));
  return Number.isSafeInteger(v) ? v : null;
}

export const parseMoney = (s: string): Kop | null => parseDecimal(s, 2);
export const parseQty = (s: string): Milli | null => parseDecimal(s, 3);

/** Число (например из JSON 71.8) → копейки без ошибок float. */
export function kopFromNumber(n: number): Kop {
  const r = parseMoney(n.toFixed(4));
  if (r === null) throw new Error(`Неверная сумма: ${n}`);
  return r;
}
export function milliFromNumber(n: number): Milli {
  const r = parseQty(n.toFixed(5));
  if (r === null) throw new Error(`Неверное количество: ${n}`);
  return r;
}

/* ───────────── Форматирование ───────────── */

const NBSP = " ";

function groupThousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** 1036920 → «10 369,20 ₴» */
export function formatMoney(kop: Kop, opts: { currency?: boolean } = {}): string {
  const neg = kop < 0;
  const abs = Math.abs(kop);
  const s = `${neg ? "−" : ""}${groupThousands(String(Math.floor(abs / 100)))},${String(abs % 100).padStart(2, "0")}`;
  return opts.currency === false ? s : `${s}${NBSP}₴`;
}

/** Цена без лишних нулей: 7180 → «71,8», 9750 → «97,5», 12000 → «120». */
export function formatPrice(kop: Kop): string {
  const s = formatMoney(kop, { currency: false });
  return s.replace(/,00$/, "").replace(/(,\d)0$/, "$1");
}

/** 1060 → «1,06», 20100 → «20,1», 300000 → «300». */
export function formatQty(milli: Milli): string {
  const int = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return groupThousands(String(int)) + (frac ? `,${frac}` : "");
}

export function formatPct(p: number | null, digits = 1): string {
  if (p === null || !Number.isFinite(p)) return "—";
  return `${p.toFixed(digits).replace(".", ",")}${NBSP}%`;
}

/* ───────────── Итоги дня ───────────── */

export type PurchaseLine = {
  qty: Milli;
  buyPrice: Kop;
  sellPrice: Kop;
  /** если закупка вводилась общей суммой — сумма как есть */
  buySum?: Kop;
};

export function purchaseBuySum(l: PurchaseLine): Kop {
  return l.buySum ?? lineSum(l.qty, l.buyPrice);
}
export function purchaseSellSum(l: PurchaseLine): Kop {
  return lineSum(l.qty, l.sellPrice);
}

export type DayPurchaseTotals = { count: number; buy: Kop; sell: Kop; profit: Kop };

export function dayPurchaseTotals(lines: PurchaseLine[]): DayPurchaseTotals {
  let buy = 0;
  let sell = 0;
  for (const l of lines) {
    buy += purchaseBuySum(l);
    sell += purchaseSellSum(l);
  }
  return { count: lines.length, buy, sell, profit: sell - buy };
}

/* ───────────── Касса и сверка ───────────── */

export type CashInput = {
  /** наличные в кассе вечером (пересчёт) */
  cashEvening: Kop;
  /** наличные утром (обычно = вчерашний вечер) */
  cashMorning: Kop;
  terminal: Kop;
  /** снял с карты и положил в кассу */
  fromCard: Kop;
  /** забрал из кассы себе */
  takenByOwner: Kop;
  /** отдано поставщикам наличными из кассы (из закупок) */
  paidSuppliersCash: Kop;
  /** расходы, оплаченные наличными из кассы */
  expensesCash: Kop;
};

/** Выручка наличными за день. */
export function cashRevenue(c: CashInput): Kop {
  return (
    c.cashEvening - c.cashMorning - c.fromCard + c.paidSuppliersCash + c.expensesCash + c.takenByOwner
  );
}

export type Reconciliation = {
  revenueCash: Kop;
  revenueTotal: Kop;
  expected: Kop;
  diff: Kop; // + излишек, − недостача
  diffPct: number | null;
};

/**
 * Сверка: ожидаемая выручка = приход − продано в долг + возвращено долгов.
 * Без учёта остатков сверка приблизительная (товар может продаться позже).
 */
export function reconcile(
  c: CashInput,
  opts: { sellTotal: Kop; soldOnCredit: Kop; debtRepaid: Kop },
): Reconciliation {
  const revenueCash = cashRevenue(c);
  const revenueTotal = revenueCash + c.terminal;
  const expected = opts.sellTotal - opts.soldOnCredit + opts.debtRepaid;
  const diff = revenueTotal - expected;
  return {
    revenueCash,
    revenueTotal,
    expected,
    diff,
    diffPct: expected > 0 ? (diff * 100) / expected : null,
  };
}
