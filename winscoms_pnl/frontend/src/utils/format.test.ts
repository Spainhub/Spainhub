import { describe, expect, it } from "vitest";
import { diff, isNegative, pctChange } from "./decimal";
import { addDays, formatDate, formatMoney, formatPercent, periodLabel, previousPeriod } from "./format";

const nb = (s: string) => s.replace(/ /g, " ");

describe("formatMoney", () => {
  it("группирует разряды и сохраняет копейки без float", () => {
    expect(formatMoney("171774")).toBe(nb("171 774,00"));
    expect(formatMoney("1234567.8")).toBe(nb("1 234 567,80"));
    expect(formatMoney("0.1")).toBe("0,10");
    expect(formatMoney("12345678901234567.89")).toBe(nb("12 345 678 901 234 567,89"));   // за пределами точности Number
  });
  it("округляет half-up по шестизнаковому хранилищу", () => {
    expect(formatMoney("245.900000")).toBe("245,90");
    expect(formatMoney("100.005")).toBe("100,01");
    expect(formatMoney("99.995")).toBe(nb("100,00"));
    expect(formatMoney("1.2345", { decimals: 0 })).toBe("1");
    expect(formatMoney("2.5", { decimals: 0 })).toBe("3");
  });
  it("отрицательные — с типографским минусом; «−0» не бывает", () => {
    expect(formatMoney("-1500.5")).toBe("−1" + " " + "500,50");
    expect(formatMoney("-0.001")).toBe("0,00");
  });
  it("нет данных → тире", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney("")).toBe("—");
    expect(formatMoney("abc")).toBe("—");
  });
  it("проценты и даты", () => {
    expect(formatPercent("22.5")).toBe("22,50 %");
    expect(formatDate("2026-07-05")).toBe("05.07.2026");
    expect(periodLabel("2026-07")).toBe("июл 2026");
    expect(periodLabel("total")).toBe("Итого");
  });
});

describe("периоды", () => {
  it("предыдущий период той же длины", () => {
    expect(previousPeriod("2026-07-01", "2026-07-31")).toEqual({ from: "2026-05-31", to: "2026-06-30" });
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("decimal", () => {
  it("точная разность и процент", () => {
    expect(diff("0.3", "0.1")).toBe("0.200000");
    expect(diff("100", null)).toBeNull();
    expect(pctChange("110", "100")).toBe("10.00");
    expect(pctChange("50", "0")).toBeNull();
    expect(isNegative("-1")).toBe(true);
    expect(isNegative("-0.000000")).toBe(false);
  });
});
