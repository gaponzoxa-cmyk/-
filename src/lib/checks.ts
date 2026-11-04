/**
 * Проверки ввода закупки: предупреждения (не запреты) — пользователь решает сам.
 */
import { formatPct, formatPrice, formatQty, markupPct, type Kop, type Milli, type Unit } from "./money";

export type Warning = { level: "warn" | "bad"; text: string };

export type HistoryLine = { qty: Milli; unit: Unit; buyPrice: Kop };

/** Товары, которые обычно считают штуками — если ввели в кг, переспросить. */
const PIECE_HINTS = ["яйц", "лаваш", "хлеб", "арбуз", "дын", "ананас", "кокос", "пучок", "пучк", "банка", "бутыл"];

export function checkPurchase(input: {
  name: string;
  qty: Milli;
  unit: Unit;
  buyPrice: Kop;
  sellPrice: Kop;
  /** прошлые закупки этого товара (новые первыми) */
  history: HistoryLine[];
  /** уже введённые строки этого дня (без редактируемой) */
  sameDay: { name: string; qty: Milli; buyPrice: Kop; sellPrice: Kop }[];
  lowMarkupPct: number;
  priceJumpPct: number;
}): Warning[] {
  const w: Warning[] = [];
  const { qty, unit, buyPrice, sellPrice, history } = input;

  // наценка
  const m = markupPct(buyPrice, sellPrice);
  if (buyPrice > 0 && sellPrice > 0 && m !== null) {
    if (sellPrice <= buyPrice) w.push({ level: "bad", text: "Цена продажи не выше цены закупки — заработка нет." });
    else if (m < input.lowMarkupPct)
      w.push({ level: "warn", text: `Низкая наценка: ${formatPct(m)} (порог ${formatPct(input.lowMarkupPct, 0)}).` });
  }

  // скачок цены закупки относительно прошлой
  const last = history.find((h) => h.unit === unit);
  if (last && buyPrice > 0 && last.buyPrice > 0) {
    const diff = ((buyPrice - last.buyPrice) * 100) / last.buyPrice;
    if (Math.abs(diff) > input.priceJumpPct)
      w.push({
        level: "warn",
        text: `Цена закупки ${diff > 0 ? "выше" : "ниже"} прошлой на ${formatPct(Math.abs(diff), 0)} (было ${formatPrice(last.buyPrice)} ₴). Проверьте.`,
      });
  }

  // подозрительное количество в кг
  if (unit === "kg") {
    const lower = input.name.toLowerCase();
    const maxHist = history.filter((h) => h.unit === "kg").reduce((a, h) => Math.max(a, h.qty), 0);
    if (PIECE_HINTS.some((h) => lower.includes(h)) && qty >= 20000)
      w.push({ level: "warn", text: `«${input.name}» ${formatQty(qty)} кг — может быть, это штуки?` });
    else if (maxHist > 0 && qty > maxHist * 3)
      w.push({ level: "warn", text: `Обычно берёте до ${formatQty(maxHist)} кг, а сейчас ${formatQty(qty)} кг. Проверьте вес.` });
    else if (maxHist === 0 && qty >= 150000)
      w.push({ level: "warn", text: `${formatQty(qty)} кг — много. Проверьте вес или единицу (кг/шт).` });
  }

  // возможный дубль
  const twin = input.sameDay.find(
    (r) => r.qty === qty && r.buyPrice === buyPrice && r.sellPrice === sellPrice,
  );
  if (twin) {
    w.push({
      level: "warn",
      text:
        twin.name.toLowerCase() === input.name.toLowerCase()
          ? "Такая строка уже есть сегодня — возможный дубль."
          : `Вес и цены полностью совпадают со строкой «${twin.name}» — не дубль ли это?`,
    });
  }
  return w;
}
