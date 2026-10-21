/**********************************************************************
 * 02_Formulas_RU.gs — ФОРМУЛЫ НА РУССКОМ
 * Скрипт пишет формулы с русскими названиями функций и «;» между
 * аргументами (как их набирают в таблице с русской локалью).
 *
 * Как Google Таблицы показывают формулы, зависит от настройки таблицы:
 *   Файл → Настройки → Язык: Россия, флажок «Всегда использовать
 *   английские названия функций» — СНЯТЬ.
 * Если таблица не приняла русскую формулу (ячейка показывает #ИМЯ? /
 * #NAME? / #ОШИБКА!), Formulas_fixRejected_ перепишет её английским
 * эквивалентом — расчёт не сломается.
 **********************************************************************/

const FORMULA_RU = {
  SUMIFS: 'СУММЕСЛИМН', SUMIF: 'СУММЕСЛИ', SUM: 'СУММ', SUMPRODUCT: 'СУММПРОИЗВ',
  COUNTIFS: 'СЧЁТЕСЛИМН', COUNTIF: 'СЧЁТЕСЛИ', COUNT: 'СЧЁТ', COUNTA: 'СЧЁТЗ',
  AVERAGEIFS: 'СРЗНАЧЕСЛИМН', AVERAGEIF: 'СРЗНАЧЕСЛИ', AVERAGE: 'СРЗНАЧ',
  MAX: 'МАКС', MIN: 'МИН', ROUND: 'ОКРУГЛ', ABS: 'ABS',
  IFERROR: 'ЕСЛИОШИБКА', IFNA: 'ЕСНД', IF: 'ЕСЛИ', AND: 'И', OR: 'ИЛИ', NOT: 'НЕ',
  ISBLANK: 'ЕПУСТО', ISNUMBER: 'ЕЧИСЛО', ISERROR: 'ЕОШИБКА',
  DATE: 'ДАТА', YEAR: 'ГОД', MONTH: 'МЕСЯЦ', DAY: 'ДЕНЬ', WEEKDAY: 'ДЕНЬНЕД',
  EOMONTH: 'КОНМЕСЯЦА', EDATE: 'ДАТАМЕС', TODAY: 'СЕГОДНЯ', NOW: 'ТДАТА', TEXT: 'ТЕКСТ',
  VLOOKUP: 'ВПР', HLOOKUP: 'ГПР', INDEX: 'ИНДЕКС', MATCH: 'ПОИСКПОЗ'
};

const FORMULA_EN = Object.keys(FORMULA_RU).reduce((o, k) => { o[FORMULA_RU[k]] = k; return o; }, {});

const FORMULA_CONST_RU = { TRUE: 'ИСТИНА', FALSE: 'ЛОЖЬ' };

const FORMULA_CONST_EN = { 'ИСТИНА': 'TRUE', 'ЛОЖЬ': 'FALSE' };

const FORMULA_ERR = /^#(NAME\?|ИМЯ\?|ERROR!|ОШИБКА!)/;

/** Пишет формулу (на русском); при исключении — английский вариант. */
function setFormulaRu_(range, formula) {
  try {
    range.setFormula(formula);
  } catch (e) {
    range.setFormula(Formulas_convert_(formula, false));
  }
}

/**
 * Перевод формулы: toRu = true — EN → RU (функции, «,» → «;», 1.5 → 1,5),
 * toRu = false — обратно. Строки в кавычках и имена листов не трогаются.
 */
function Formulas_convert_(f, toRu) {
  const dict = toRu ? FORMULA_RU : FORMULA_EN;
  const consts = toRu ? FORMULA_CONST_RU : FORMULA_CONST_EN;
  const isDigit = c => c >= '0' && c <= '9';
  let out = '';
  let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (ch === '"' || ch === "'") {           // "текст" или 'Имя листа'
      let j = i + 1;
      while (j < f.length) {
        if (f[j] === ch) { if (f[j + 1] === ch) { j += 2; continue; } break; }
        j++;
      }
      out += f.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-zА-Яа-яЁё_]/.test(ch)) {       // имя функции / ссылка
      let j = i;
      while (j < f.length && /[A-Za-zА-Яа-яЁё0-9_.]/.test(f[j])) j++;
      const word = f.slice(i, j);
      const k = word.toUpperCase();
      const tr = dict[k];
      if (f[j] === '(' && tr) out += tr;
      else if (f[j] !== '(' && f[j] !== '!' && consts[k]) out += consts[k]; // ИСТИНА / ЛОЖЬ
      else out += word;
      i = j;
      continue;
    }
    if (toRu && ch === ',') { out += ';'; i++; continue; }
    if (toRu && ch === '.' && isDigit(f[i - 1] || '') && isDigit(f[i + 1] || '')) { out += ','; i++; continue; }
    if (!toRu && ch === ';') { out += ','; i++; continue; }
    if (!toRu && ch === ',' && isDigit(f[i - 1] || '') && isDigit(f[i + 1] || '')) { out += '.'; i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** Ячейки с русской формулой, которую таблица не приняла, → английский вариант. */
function Formulas_fixRejected_(sh) {
  SpreadsheetApp.flush();
  const rng = sh.getDataRange();
  const formulas = rng.getFormulas();
  const disp = rng.getDisplayValues();
  let fixed = 0;
  formulas.forEach((row, r) => row.forEach((f, c) => {
    if (!f || !FORMULA_ERR.test(disp[r][c])) return;
    const en = Formulas_convert_(f, false);
    if (en !== f) { rng.getCell(r + 1, c + 1).setFormula(en); fixed++; }
  }));
  if (fixed) Logger.log(`Лист ${sh.getName()}: русские формулы не приняты в ${fixed} ячейках — записаны на английском.`);
  return fixed;
}

/**
 * Пункт меню: перевести все формулы АКТИВНОГО листа на русский (ваши
 * формулы тоже). Значения и ручные ячейки не трогаются. Ячейка, которая
 * после перевода стала ошибкой, возвращается к исходной формуле.
 */
function Formulas_activeSheetToRussian() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const ok = ui.alert('Формулы на русском',
    `Перевести формулы листа «${sh.getName()}» на русские названия функций?`, ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const rng = sh.getDataRange();
  const before = rng.getFormulas();
  const errBefore = rng.getDisplayValues().map(r => r.map(v => FORMULA_ERR.test(v)));
  let changed = 0;
  before.forEach((row, r) => row.forEach((f, c) => {
    if (!f) return;
    const ru = Formulas_convert_(f, true);
    if (ru === f) return;
    try { rng.getCell(r + 1, c + 1).setFormula(ru); changed++; } catch (e) { /* оставляем как было */ }
  }));

  SpreadsheetApp.flush();
  const after = rng.getDisplayValues();
  let reverted = 0;
  before.forEach((row, r) => row.forEach((f, c) => {
    if (f && !errBefore[r][c] && FORMULA_ERR.test(after[r][c])) {
      rng.getCell(r + 1, c + 1).setFormula(f);
      reverted++;
    }
  }));

  ui.alert('Формулы на русском',
    `Переведено формул: ${changed - reverted}.` +
    (reverted ? `\nНе приняты таблицей и оставлены как были: ${reverted}.` : '') +
    '\n\nЕсли в ячейках всё ещё английские названия: Файл → Настройки → ' +
    'снимите флажок «Всегда использовать английские названия функций» (язык — Россия).',
    ui.ButtonSet.OK);
}
