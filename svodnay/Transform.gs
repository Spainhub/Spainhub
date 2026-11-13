/**
 * Transform.gs — сборка итоговой таблицы из кэшей.
 */
function ozonBuildFinalRows_() {
  const sheets = OZON_CONFIG.cacheSheets;
  const products = ozonReadObjectMap_(sheets.products);
  const info = ozonReadObjectMap_(sheets.info);
  const attributes = ozonReadObjectMap_(sheets.attributes);
  const categories = ozonReadObjectMap_(sheets.categories);
  const prices = ozonReadObjectMap_(sheets.prices);
  const fbsPostings = ozonReadObjects_(sheets.fbsPostings180);
  const fboPostings = ozonReadObjects_(sheets.fboPostings180);
  const allPostings = fboPostings.concat(fbsPostings);

  const stocks = ozonAggregateStocks_();
  const finance = ozonCalculateFinance_();
  const buyout = ozonCalculateBuyout_(allPostings);
  const coinvest = ozonCalculateCoinvest_(fbsPostings); // соинвест — по FBS за последние 14 дней
  const monthlySales = ozonCalculateMonthlySales_(allPostings);

  const rows = Object.keys(products).map((productId) => {
    const product = products[productId] || {};
    const productInfo = info[productId] || {};
    const attr = attributes[productId] || {};
    const priceRow = prices[productId] || {};
    const offerId = product.offer_id || productInfo.offer_id || '';
    const price = priceRow.price || {};
    const commissions = priceRow.commissions || {};
    const stock = stocks[offerId] || {};

    return [
      ozonStatusFromInfo_(productInfo),
      offerId,
      ozonSkuFromInfo_(productInfo, attr),
      stock.fbs || 0,
      stock.fbo || 0,
      price.marketing_seller_price || '',
      commissions.sales_percent_fbo || '',
      commissions.sales_percent_fbs || '',
      (buyout[offerId] || {}).percent || '',
      finance.acquiringPercent,
      finance.salesRevenue,
      finance.marketing,
      Math.round(ozonNormalizeDimension_(attr.depth, attr.dimension_unit, 'mm') * 100) / 100,
      Math.round(ozonNormalizeDimension_(attr.width, attr.dimension_unit, 'mm') * 100) / 100,
      Math.round(ozonNormalizeDimension_(attr.height, attr.dimension_unit, 'mm') * 100) / 100,
      Math.round(ozonNormalizeDimension_(attr.weight, attr.weight_unit, 'g') * 100) / 100,
      coinvest[offerId] || '',
      ozonProductTypeName_(attr, categories),
      commissions.sales_percent_rfbs || '',
      monthlySales[offerId] || 0
    ];
  });

  // Отметка времени — в заголовке дополнительной колонки, данные в ней пустые
  const updatedAt = Utilities.formatDate(new Date(), OZON_CONFIG.timezone, 'dd.MM.yyyy HH:mm');
  const values = [OZON_CONFIG.headers.concat(['Последнее обновление: ' + updatedAt])];
  rows.forEach((row) => values.push(row.concat([''])));
  ozonWriteFinalRowsCache_(values);
}

/** Словарь sku -> offer_id (по данным о товарах); нужен, т.к. остатки запрашиваются по sku. */
function ozonBuildSkuToOffer_() {
  const products = ozonReadObjectMap_(OZON_CONFIG.cacheSheets.products);
  const info = ozonReadObjectMap_(OZON_CONFIG.cacheSheets.info);
  const result = {};
  Object.keys(products).forEach((productId) => {
    const item = info[productId] || {};
    const offerId = (products[productId] || {}).offer_id || item.offer_id;
    if (!offerId) return;
    [item.sku, item.fbo_sku, item.fbs_sku].forEach((sku) => { if (sku) result[String(sku)] = offerId; });
    (item.sources || []).forEach((s) => { if (s.sku) result[String(s.sku)] = offerId; });
    ((item.stocks || {}).stocks || []).forEach((s) => { if (s.sku) result[String(s.sku)] = offerId; });
  });
  return result;
}

/** Остатки FBS/FBO по offer_id: свободный остаток (present − reserved), не меньше 0. */
function ozonAggregateStocks_() {
  const result = {};
  function add(schema, row) {
    const offerId = row.offer_id;
    if (!offerId) return;
    if (!result[offerId]) result[offerId] = { fbs: 0, fbo: 0 };
    const free = row.free_stock !== undefined && row.free_stock !== null
      ? Number(row.free_stock)
      : Number(row.present || 0) - Number(row.reserved || 0);
    result[offerId][schema] += Math.max(free || 0, 0);
  }
  ozonReadObjects_(OZON_CONFIG.cacheSheets.fbsStocks).forEach((row) => add('fbs', row));
  ozonReadObjects_(OZON_CONFIG.cacheSheets.fboStocks).forEach((row) => add('fbo', row));
  return result;
}

/** Эквайринг %, маркетинг и выручка по финансовому балансу. */
function ozonCalculateFinance_() {
  const row = ozonReadObjectMap_(OZON_CONFIG.cacheSheets.finance).finance || {};
  const cashflows = (row.body || {}).cashflows || {};
  const services = cashflows.services || [];
  const salesRevenue = ozonNumber_((((cashflows.sales || {}).amount_details || {}).revenue) || {});
  const acquiring = ozonServiceAmount_(services, 'acquiring');
  const marketing = ozonServiceAmount_(services, 'promotion_with_cost_per_order');
  return {
    acquiringPercent: ozonPct_(Math.abs(acquiring), salesRevenue),
    marketing: Math.abs(marketing),
    salesRevenue
  };
}

function ozonServiceAmount_(services, name) {
  for (let i = 0; i < services.length; i += 1) {
    if (services[i].name === name) return ozonNumber_(services[i].amount || {});
  }
  return 0;
}

function ozonPostingDate_(posting) {
  return posting.created_at || posting.in_process_at || posting.shipment_date || '';
}

/** % выкупа по каждому offer_id: доля delivered среди последних 50 единиц за 180 дней. */
function ozonCalculateBuyout_(postings) {
  const byOffer = {};
  postings.forEach((posting) => {
    const date = ozonPostingDate_(posting);
    (posting.products || []).forEach((product) => {
      const offerId = product.offer_id || '';
      if (!offerId) return;
      if (!byOffer[offerId]) byOffer[offerId] = [];
      byOffer[offerId].push({ date, status: posting.status || 'unknown', qty: Number(product.quantity || 1) });
    });
  });

  const result = {};
  Object.keys(byOffer).forEach((offerId) => {
    const selected = ozonSelectLastUnits_(byOffer[offerId], 50);
    const total = selected.reduce((sum, r) => sum + r.selectedQty, 0);
    const delivered = selected.filter((r) => r.status === 'delivered').reduce((sum, r) => sum + r.selectedQty, 0);
    result[offerId] = { selectedUnits: total, delivered, percent: ozonPct_(delivered, total) };
  });
  return result;
}

/** Берём самые свежие заказы, пока не наберём `limit` единиц. */
function ozonSelectLastUnits_(orders, limit) {
  const selected = [];
  let used = 0;
  orders.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  orders.forEach((order) => {
    if (used >= limit) return;
    const take = Math.min(Number(order.qty || 1), limit - used);
    selected.push({ status: order.status, selectedQty: take });
    used += take;
  });
  return selected;
}

/** Продажи за последние 28 дней: сумма количества по offer_id. */
function ozonCalculateMonthlySales_(postings) {
  const period = ozonPeriodDateTime_(28);
  const result = {};
  postings.forEach((posting) => {
    const date = ozonPostingDate_(posting);
    if (!date || date < period.from || date > period.to) return;
    (posting.products || []).forEach((product) => {
      const offerId = product.offer_id || '';
      if (!offerId) return;
      result[offerId] = (result[offerId] || 0) + Number(product.quantity || 1);
    });
  });
  return result;
}

/** Соинвест Ozon %: (цена продавца − цена покупателя) / цена продавца по FBS за последние 14 дней. */
function ozonCalculateCoinvest_(fbsPostings) {
  const from = ozonPeriodDateTime_(14).from;
  const byOffer = {};
  fbsPostings.forEach((posting) => {
    const date = ozonPostingDate_(posting);
    if (!date || date < from) return;
    const financialProducts = (posting.financial_data || {}).products || [];
    (posting.products || []).forEach((product, index) => {
      const financial = ozonFindFinancialProduct_(financialProducts, product, index);
      const customerPrice = financial.customer_price || {};
      if (customerPrice.currency !== 'RUB') return;
      const seller = ozonNumber_(financial.price);
      const paid = ozonNumber_(customerPrice.amount);
      const qty = Number(financial.quantity || product.quantity || 1);
      const offerId = product.offer_id || '';
      if (!seller || !paid || !offerId) return;
      if (!byOffer[offerId]) byOffer[offerId] = { seller: 0, paid: 0 };
      byOffer[offerId].seller += seller * qty;
      byOffer[offerId].paid += paid * qty;
    });
  });
  const result = {};
  Object.keys(byOffer).forEach((offerId) => {
    result[offerId] = ozonPct_(byOffer[offerId].seller - byOffer[offerId].paid, byOffer[offerId].seller);
  });
  return result;
}

function ozonFindFinancialProduct_(items, product, index) {
  const sku = String(product.sku || '');
  for (let i = 0; i < items.length; i += 1) {
    if (String(items[i].product_id || '') === sku) return items[i];
  }
  return items[index] || {};
}

function ozonStatusFromInfo_(info) {
  const statuses = info.statuses || {};
  return statuses.status_name || statuses.status || '';
}

function ozonSkuFromInfo_(info, attr) {
  const candidates = [info.sku, info.fbo_sku, info.fbs_sku, attr.sku];
  for (let i = 0; i < candidates.length; i += 1) {
    if (candidates[i]) return candidates[i];
  }
  const sources = info.sources || [];
  return sources.length ? sources[0].sku || '' : '';
}

function ozonProductTypeName_(attr, categories) {
  const row = categories[(attr.description_category_id || '') + ':' + (attr.type_id || '')] ||
    categories[String(attr.type_id || '')] || {};
  return row.typeName || '';
}
