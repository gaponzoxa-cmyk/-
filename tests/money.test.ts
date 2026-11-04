import { describe, expect, it } from "vitest";
import seed from "../supabase/seed/purchases-2026-11-01_04.json";
import {
  dayPurchaseTotals,
  divRoundHalfUp,
  formatMoney,
  formatPrice,
  formatQty,
  kopFromNumber,
  lineSum,
  markupPct,
  milliFromNumber,
  parseMoney,
  parseQty,
  priceFromSum,
  reconcile,
  sellPriceByMarkup,
  type PurchaseLine,
} from "../src/lib/money";
import { addDays, formatDayLong, isIsoDate, kyivToday } from "../src/lib/dates";

describe("контрольные итоги из Excel (1–4 ноября 2026)", () => {
  const expected: Record<string, { count: number; buy: string; sell: string; profit: string }> = {
    "2026-11-01": { count: 5, buy: "7 393,60", sell: "10 369,20", profit: "2 975,60" },
    "2026-11-02": { count: 7, buy: "7 701,70", sell: "10 436,20", profit: "2 734,50" },
    "2026-11-03": { count: 16, buy: "12 550,06", sell: "16 301,55", profit: "3 751,49" },
    "2026-11-04": { count: 13, buy: "9 048,04", sell: "13 243,90", profit: "4 195,86" },
  };

  const byDay = new Map<string, PurchaseLine[]>();
  for (const r of seed) {
    const list = byDay.get(r.date) ?? [];
    list.push({
      qty: milliFromNumber(r.qty),
      buyPrice: kopFromNumber(r.buyPrice),
      sellPrice: kopFromNumber(r.sellPrice),
    });
    byDay.set(r.date, list);
  }

  for (const [day, exp] of Object.entries(expected)) {
    it(`${day}: позиций ${exp.count}, закупка ${exp.buy}, приход ${exp.sell}, заработок ${exp.profit}`, () => {
      const t = dayPurchaseTotals(byDay.get(day) ?? []);
      expect(t.count).toBe(exp.count);
      expect(formatMoney(t.buy, { currency: false }).replace(/ /g, " ")).toBe(exp.buy);
      expect(formatMoney(t.sell, { currency: false }).replace(/ /g, " ")).toBe(exp.sell);
      expect(formatMoney(t.profit, { currency: false }).replace(/ /g, " ")).toBe(exp.profit);
    });
  }
});

describe("округление", () => {
  it("половина вверх", () => {
    expect(divRoundHalfUp(5, 10)).toBe(1);
    expect(divRoundHalfUp(4, 10)).toBe(0);
    expect(divRoundHalfUp(15, 10)).toBe(2);
  });
  it("сумма строки", () => {
    expect(lineSum(1060, 25000)).toBe(26500); // 1,06 кг × 250 ₴
    expect(lineSum(20200, 7180)).toBe(145036); // 20,2 × 71,8
    expect(lineSum(333, 1)).toBe(0); // 0,333 × 0,01 = 0,00333 → 0
    expect(lineSum(500, 1)).toBe(1); // 0,005 → 0,01 (половина вверх)
  });
});

describe("цена из общей суммы", () => {
  it("1450,36 за 20,2 кг → 71,80", () => {
    expect(priceFromSum(145036, 20200)).toBe(7180);
  });
  it("659,70 за 9 кг → 73,30", () => {
    expect(priceFromSum(65970, 9000)).toBe(7330);
  });
  it("1000 ₴ за 7,3 кг → 136,99", () => {
    expect(priceFromSum(100000, 7300)).toBe(13699);
  });
});

describe("цена продажи по наценке (вверх до 1 ₴)", () => {
  it("71,8 + 30% = 93,34 → 94", () => {
    expect(sellPriceByMarkup(7180, 30)).toBe(9400);
  });
  it("ровно попадает — не округляем лишнего: 100 + 30% = 130", () => {
    expect(sellPriceByMarkup(10000, 30)).toBe(13000);
  });
  it("шаг 0,5 ₴: 75 + 30% = 97,5", () => {
    expect(sellPriceByMarkup(7500, 30, 50)).toBe(9750);
  });
  it("дробная наценка 32,5%", () => {
    expect(sellPriceByMarkup(10000, 32.5)).toBe(13300); // 132,5 → 133
  });
  it("наценка в %", () => {
    expect(markupPct(8000, 10400)).toBeCloseTo(30);
    expect(markupPct(0, 100)).toBeNull();
  });
});

describe("разбор ввода", () => {
  it("деньги", () => {
    expect(parseMoney("71,8")).toBe(7180);
    expect(parseMoney("71.8")).toBe(7180);
    expect(parseMoney("1 450,36")).toBe(145036);
    expect(parseMoney("12")).toBe(1200);
    expect(parseMoney("0,005")).toBe(1);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("-5")).toBeNull();
  });
  it("количество", () => {
    expect(parseQty("1,06")).toBe(1060);
    expect(parseQty("20,1")).toBe(20100);
    expect(parseQty("300")).toBe(300000);
  });
  it("из чисел JSON без ошибок float", () => {
    expect(kopFromNumber(71.8)).toBe(7180);
    expect(kopFromNumber(110.5)).toBe(11050);
    expect(milliFromNumber(1.06)).toBe(1060);
    expect(milliFromNumber(0.1 + 0.2)).toBe(300);
  });
});

describe("форматирование", () => {
  it("деньги", () => {
    expect(formatMoney(1036920)).toBe("10 369,20 ₴");
    expect(formatMoney(-5)).toBe("−0,05 ₴");
  });
  it("цены и количество", () => {
    expect(formatPrice(7180)).toBe("71,8");
    expect(formatPrice(12000)).toBe("120");
    expect(formatPrice(11050)).toBe("110,5");
    expect(formatQty(1060)).toBe("1,06");
    expect(formatQty(300000)).toBe("300");
  });
});

describe("сверка кассы", () => {
  it("пример из обсуждения: утром 2000, снял с карты 3000, поставщику 5000, вечером 6000", () => {
    const r = reconcile(
      {
        cashMorning: 200000,
        fromCard: 300000,
        paidSuppliersCash: 500000,
        cashEvening: 600000,
        expensesCash: 0,
        takenByOwner: 0,
        terminal: 400000,
      },
      { sellTotal: 1000000, soldOnCredit: 0, debtRepaid: 0 },
    );
    expect(r.revenueCash).toBe(600000);
    expect(r.revenueTotal).toBe(1000000);
    expect(r.diff).toBe(0);
    expect(r.diffPct).toBe(0);
  });
  it("продажа в долг уменьшает ожидаемую выручку", () => {
    const r = reconcile(
      {
        cashMorning: 0,
        fromCard: 0,
        paidSuppliersCash: 0,
        cashEvening: 90000,
        expensesCash: 0,
        takenByOwner: 0,
        terminal: 0,
      },
      { sellTotal: 100000, soldOnCredit: 10000, debtRepaid: 0 },
    );
    expect(r.expected).toBe(90000);
    expect(r.diff).toBe(0);
  });
});

describe("даты (Киев)", () => {
  it("сегодня по Киеву, а не по UTC", () => {
    // 22:30 UTC 4 ноября = 00:30 5 ноября в Киеве (UTC+2 зимой)
    expect(kyivToday(new Date("2026-11-04T22:30:00Z"))).toBe("2026-11-05");
    expect(kyivToday(new Date("2026-11-04T21:30:00Z"))).toBe("2026-11-04");
  });
  it("переход через месяц и формат", () => {
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(formatDayLong("2026-11-04")).toBe("4 ноября, среда");
    expect(isIsoDate("2026-02-30")).toBe(false);
  });
});

describe("импорт 1–4 ноября с исправлениями", async () => {
  const { seedRows, SEED_CONTROL } = await import("../src/lib/seed");
  it("яйцо стало штуками, итоги совпадают с таблицей", () => {
    const rows = seedRows();
    expect(rows.find((r) => r.name === "Яйцо")?.unit).toBe("pcs");
    for (const [day, c] of Object.entries(SEED_CONTROL)) {
      const t = dayPurchaseTotals(rows.filter((r) => r.date === day));
      expect(t).toEqual({ count: c.count, buy: c.buy, sell: c.sell, profit: c.profit });
    }
  });
});
