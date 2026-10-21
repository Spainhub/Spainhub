/**********************************************************************
 * 13_Web_Params.gs — ЛИСТ ПАРАМЕТРЫ → вкладка 1 Web App
 *
 * Заголовки A6:C6: № | Параметры | Выбор и ввод данных. Параметры — с 7-й
 * строки, значение — в колонке C. Что показывается в Web App:
 *  - ячейка C с выпадающим списком (проверка данных «значение из списка /
 *    диапазона») → выпадающий список с теми же вариантами;
 *  - ячейка C с формулой → только чтение;
 *  - прочая ячейка с подписью в B → поле ввода;
 *  - строка с подписью, но без значения, номера и списка → заголовок группы.
 * Выбор в Web App записывается в ячейку C (и наоборот — значения, которые
 * меняют в таблице, подтягиваются в приложение). Варианты списка берутся из
 * правила проверки данных ячейки каждый раз заново, поэтому зависимые
 * списки (когда варианты зависят от других ячеек) тоже работают.
 *
 * ВАЖНО: все имена в этом файле имеют префикс Params_.
 **********************************************************************/

/** Данные вкладки «ПАРАМЕТРЫ». Каждый вызов читает лист заново. */
function Params_getData() {
  const sh = Web_sheet_(SHEET_PARAMS);
  const lastRow = sh.getLastRow();
  const head = sh.getRange(PARAMS_HEADER_ROW, 1, 1, 3).getDisplayValues()[0].map(s => String(s).trim());
  const rows = [];
  const n = lastRow - PARAMS_FIRST_ROW + 1;
  if (n > 0) {
    const disp = sh.getRange(PARAMS_FIRST_ROW, 1, n, PARAMS_VALUE_COL).getDisplayValues();
    const valCol = sh.getRange(PARAMS_FIRST_ROW, PARAMS_VALUE_COL, n, 1);
    const formulas = valCol.getFormulas();
    const rules = valCol.getDataValidations();
    for (let k = 0; k < n; k++) {
      const num = String(disp[k][0]).trim();
      const name = String(disp[k][1]).trim();
      const value = String(disp[k][PARAMS_VALUE_COL - 1]).trim();
      const rule = rules[k][0];
      if (!num && !name && !value && !rule) continue;

      const v = Util_validOptions_(rule);
      let kind, options = [];
      if (formulas[k][0]) {
        kind = 'text';
      } else if (v && v.kind === 'list') {
        kind = 'select';
        options = v.options.slice();
        if (value && options.indexOf(value) < 0) options.unshift(value); // значение, которого нет в списке, не теряем
      } else if (v || value !== '' || /^\d+(\.\d+)*$/.test(num)) {
        kind = 'input';
      } else {
        kind = 'section';
      }
      rows.push({
        row: PARAMS_FIRST_ROW + k,
        num: num,
        name: name,
        kind: kind,
        value: value,
        options: options
      });
    }
  }
  return {
    title: String(sh.getRange('A1').getDisplayValue()).trim(),
    subtitle: String(sh.getRange('A2').getDisplayValue()).trim(),
    headers: head,
    rows: rows
  };
}

/**
 * Запись значения параметра из Web App в ячейку C листа ПАРАМЕТРЫ.
 * row — номер строки листа. Для выпадающего списка значение должно входить
 * в список; ячейки с формулами не меняются. Возвращает свежие данные вкладки.
 */
function Params_setValue(row, value) {
  Web_assertCanWrite_();
  const sh = Web_sheet_(SHEET_PARAMS);
  row = Number(row);
  if (!(row >= PARAMS_FIRST_ROW && row <= sh.getLastRow())) {
    throw new Error('Недопустимая строка параметра.');
  }
  const cell = sh.getRange(row, PARAMS_VALUE_COL);
  if (cell.getFormula()) throw new Error('В ячейке формула — изменить значение нельзя.');

  const s = String(value === null || value === undefined ? '' : value).trim();
  if (s.length > 200) throw new Error('Слишком длинное значение.');
  const v = Util_validOptions_(cell.getDataValidation());
  if (v && v.kind === 'list' && s !== '' && v.options.indexOf(s) < 0) {
    throw new Error(`Значение «${s}» не входит в список этого параметра.`);
  }
  cell.setValue(s);          // как ввод с клавиатуры: «20%», «1,5» таблица разбирает сама
  SpreadsheetApp.flush();
  return Params_getData();
}
