import { describe, expect, it } from "vitest";
import { checkPurchase } from "../src/lib/checks";

const base = {
  name: "Банан",
  qty: 20200,
  unit: "kg" as const,
  buyPrice: 7180,
  sellPrice: 9000,
  history: [],
  sameDay: [],
  lowMarkupPct: 30,
  priceJumpPct: 20,
};

describe("проверки ввода закупки", () => {
  it("низкая наценка ниже 30%", () => {
    const w = checkPurchase(base); // 25,3 %
    expect(w.map((x) => x.text).join()).toContain("Низкая наценка");
  });
  it("нормальная наценка — без предупреждений", () => {
    expect(checkPurchase({ ...base, sellPrice: 9400 })).toEqual([]);
  });
  it("Яйцо 300 кг — может быть штуки", () => {
    const w = checkPurchase({ ...base, name: "Яйцо", qty: 300000, buyPrice: 850, sellPrice: 1200 });
    expect(w.some((x) => x.text.includes("штуки"))).toBe(true);
  });
  it("Розовый 68,6 после 90 — скачок цены", () => {
    const w = checkPurchase({
      ...base,
      name: "Розовый",
      qty: 6400,
      buyPrice: 6860,
      sellPrice: 13000,
      history: [{ qty: 6300, unit: "kg", buyPrice: 9000 }],
    });
    expect(w.some((x) => x.text.includes("ниже прошлой на 24"))).toBe(true);
  });
  it("Сливка и Помидор красный — одинаковые числа", () => {
    const w = checkPurchase({
      ...base,
      name: "Помидор красный",
      qty: 6100,
      buyPrice: 8500,
      sellPrice: 11050,
      sameDay: [{ name: "Сливка", qty: 6100, buyPrice: 8500, sellPrice: 11050 }],
    });
    expect(w.some((x) => x.text.includes("«Сливка»"))).toBe(true);
  });
  it("Картофель 85 кг при истории до 45,6 — без паники (меньше ×3)", () => {
    const w = checkPurchase({
      ...base,
      name: "Картофель",
      qty: 85000,
      buyPrice: 1200,
      sellPrice: 2000,
      history: [{ qty: 45600, unit: "kg", buyPrice: 1200 }],
    });
    expect(w).toEqual([]);
  });
});
