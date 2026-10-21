/**********************************************************************
 * 17_Web_Ref.gs — ЛИСТ СПРАВКА → вкладка 5 Web App
 *
 * Лист устроен так:
 *   B2 (подпись — A2) — выпадающий список «номер отчёта». Это ячейка-селектор:
 *       выбор в Web App записывается в B2, лист пересчитывается (ваши
 *       формулы берут номер отчёта из B2), и приложение показывает свежие
 *       значения; если B2 меняют в самой таблице — приложение подхватывает;
 *   строка 6 — заголовки: № | Страна: | Итого | Армения | Беларусь | Казахстан |
 *       Киргизия | Россия … (страны можно добавлять — новые колонки появятся
 *       в приложении сами; колонка с пустым заголовком или «-» не показывается);
 *   строки с 7-й — данные. Нумерация в колонке A (1, 1.1, 2, 2.1.1 …) задаёт
 *       иерархию: строки с подстроками сворачиваются, как в P&L ОТЧЕТ.
 * Значения в Web App показываются ТАК ЖЕ, как в таблице (формат ячеек:
 * проценты, знаки после запятой, единицы).
 *
 * ВАЖНО: все имена в этом файле имеют префикс Ref_.
 **********************************************************************/

/** Данные вкладки «СПРАВКА». Каждый вызов читает лист заново. */
function Ref_getData() {
  const sh = Web_sheet_(SHEET_REF);
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const sel = sh.getRange(REF_SELECT_CELL);
  const selected = String(sel.getDisplayValue()).trim();
  const v = Util_validOptions_(sel.getDataValidation());
  const options = v && v.kind === 'list' ? v.options.slice() : [];
  if (selected && options.indexOf(selected) < 0) options.unshift(selected);
  const label = String(sh.getRange(REF_LABEL_CELL).getDisplayValue()).trim() || 'Номер отчёта';

  const lastCol = Math.max(sh.getLastColumn(), 3);
  const lastRow = sh.getLastRow();
  const head = sh.getRange(REF_HEADER_ROW, 1, 1, lastCol).getDisplayValues()[0].map(s => String(s).trim());
  // Колонки значений — C и правее; пустой заголовок или «-» — колонку не показываем
  const colIdx = [];
  for (let i = 2; i < lastCol; i++) if (!isDashHeader_(head[i])) colIdx.push(i);

  const rows = [];
  const cnt = lastRow - REF_FIRST_ROW + 1;
  if (cnt > 0) {
    const blk = sh.getRange(REF_FIRST_ROW, 1, cnt, lastCol);
    const raw = blk.getValues();
    const disp = blk.getDisplayValues();
    raw.forEach((r, k) => {
      const d = disp[k];
      const name = String(d[1]).trim();
      const num = Util_numFromCell_(r[0], d[0], tz);
      const cells = colIdx.map(i => String(d[i]));
      if (!name && !num && cells.every(c => c.trim() === '')) return;
      rows.push({
        num: num,
        name: name,
        cells: cells,
        vals: colIdx.map(i => typeof r[i] === 'number' ? r[i] : null)
      });
    });
    Util_hierAnnotate_(rows);
  }

  return {
    title: String(sh.getRange('A1').getDisplayValue()).trim(),
    label: label,
    selected: selected,
    options: options,
    headerNum: head[0] || '№',
    headerName: head[1] || '',
    columns: colIdx.map(i => head[i]),
    rows: rows
  };
}

/**
 * Выбор номера отчёта в Web App → ячейка B2 (значение должно входить в список
 * проверки данных ячейки). Лист пересчитывается; возвращает свежие данные.
 */
function Ref_setReport(value) {
  Web_assertCanWrite_();
  const sh = Web_sheet_(SHEET_REF);
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) throw new Error('Номер отчёта не выбран.');
  const sel = sh.getRange(REF_SELECT_CELL);
  const v = Util_validOptions_(sel.getDataValidation());
  if (v && v.kind === 'list' && v.options.indexOf(s) < 0) {
    throw new Error(`Отчёт «${s}» не входит в список.`);
  }
  sel.setValue(s);         // как ввод с клавиатуры: «1» станет числом, «Q1» — текстом
  SpreadsheetApp.flush();
  return Ref_getData();
}
