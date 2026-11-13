/**
 * Utils.gs — вспомогательные функции чисел, дат и единиц измерения.
 */

/** Число из числа, строки («1 234,5») или объекта {value|amount}; иначе 0. */
function ozonNumber_(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'object') {
    return ozonNumber_(value.value !== undefined ? value.value : value.amount);
  }
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Процент num/den с точностью до 0.01; пустая строка, если знаменатель 0. */
function ozonPct_(num, den) {
  const denominator = ozonNumber_(den);
  if (!denominator) return '';
  return Math.round((ozonNumber_(num) / denominator) * 10000) / 100;
}

/** Дата «N дней назад» в формате yyyy-MM-dd в часовом поясе проекта. */
function ozonDateDaysAgo_(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return Utilities.formatDate(d, OZON_CONFIG.timezone, 'yyyy-MM-dd');
}

/** Период из `days` дней, заканчивающийся вчера (вчерашний день включительно). */
function ozonPeriodDaysEndingYesterday_(days) {
  return { dateFrom: ozonDateDaysAgo_(days), dateTo: ozonDateDaysAgo_(1) };
}

/** То же, но в формате ISO date-time для методов с точным временем. */
function ozonPeriodDateTime_(days) {
  const p = ozonPeriodDaysEndingYesterday_(days);
  return { from: p.dateFrom + 'T00:00:00Z', to: p.dateTo + 'T23:59:59Z' };
}

/** Приведение размеров к мм (target='mm') или весов к граммам (target='g'). */
function ozonNormalizeDimension_(value, unit, target) {
  const num = ozonNumber_(value);
  const u = String(unit || '').toLowerCase();
  if (target === 'mm') {
    if (u === 'mm' || u === 'мм') return num;
    if (u === 'cm' || u === 'см') return num * 10;
    if (u === 'm' || u === 'м') return num * 1000;
  }
  if (target === 'g') {
    if (u === 'g' || u === 'г' || u === 'гр') return num;
    if (u === 'kg' || u === 'кг') return num * 1000;
  }
  return num;
}
