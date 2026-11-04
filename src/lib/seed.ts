/**
 * Данные владельца за 1–4 ноября 2026 из старой таблицы Excel
 * с исправлениями, согласованными 04.11.2026:
 *  - «Яйцо» 01.11: 300 — это штуки, а не кг (суммы не меняются);
 *  - «Розовый» 04.11 по 68,6 — цена верная, оставляем;
 *  - «Сливка» и «Помидор красный» 04.11 — разные товары, оставляем обе строки.
 */
import raw from "../../supabase/seed/purchases-2026-11-01_04.json";
import { kopFromNumber, milliFromNumber, type Kop, type Milli, type Unit } from "./money";

export type ImportRow = { date: string; name: string; unit: Unit; qty: Milli; buyPrice: Kop; sellPrice: Kop; note?: string };

export const SEED_CONTROL: Record<string, { count: number; buy: Kop; sell: Kop; profit: Kop }> = {
  "2026-11-01": { count: 5, buy: 739360, sell: 1036920, profit: 297560 },
  "2026-11-02": { count: 7, buy: 770170, sell: 1043620, profit: 273450 },
  "2026-11-03": { count: 16, buy: 1255006, sell: 1630155, profit: 375149 },
  "2026-11-04": { count: 13, buy: 904804, sell: 1324390, profit: 419586 },
};

export function seedRows(): ImportRow[] {
  return raw.map((r) => {
    const egg = r.name === "Яйцо" && r.date === "2026-11-01";
    return {
      date: r.date,
      name: r.name,
      unit: egg ? "pcs" : r.unit === "шт" ? "pcs" : "kg",
      qty: milliFromNumber(r.qty),
      buyPrice: kopFromNumber(r.buyPrice),
      sellPrice: kopFromNumber(r.sellPrice),
      note: egg ? "Исправлено: 300 кг → 300 шт" : undefined,
    };
  });
}

/** Позиции с постоянными id (одни и те же при каждом переносе — без дублей). */
export async function seedRowsWithIds(shopId: string) {
  const { stableId } = await import("./ids");
  const pos: Record<string, number> = {};
  const out: (ImportRow & { id: string; position: number })[] = [];
  for (const r of seedRows()) {
    pos[r.date] = (pos[r.date] ?? 0) + 1;
    out.push({ ...r, position: pos[r.date], id: await stableId(`seed-2026-11:${shopId}:${r.date}:${pos[r.date]}:${r.name}`) });
  }
  return out;
}
