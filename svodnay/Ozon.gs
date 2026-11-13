/**
 * Ozon.gs — шаги загрузки данных из Ozon Seller API.
 * Один шаг = один HTTP-запрос; состояние (курсор/номер порции) возвращается в phaseState,
 * поэтому загрузку можно прервать по лимиту времени и продолжить позже.
 * Ответы сужаются до нужных полей: ячейка листа вмещает ≤ 50 000 символов.
 */

/** Список товаров (пагинация по last_id, до 1000 за запрос). */
function ozonFetchProductsStep_(phaseState) {
  const lastId = phaseState.lastId || '';
  const body = ozonRequestJson_('/v3/product/list', {
    filter: { visibility: 'ALL' },
    last_id: lastId,
    limit: 1000
  }, 'список товаров');
  const result = body.result || {};
  const items = result.items || [];
  ozonAppendObjects_(OZON_CONFIG.cacheSheets.products, 'product_id',
    items.map((i) => ({ product_id: i.product_id, offer_id: i.offer_id })));
  const nextLastId = result.last_id || '';
  if (!items.length || !nextLastId || nextLastId === lastId) return { done: true };
  return { done: false, phaseState: { lastId: nextLastId } };
}

/** Информация о товарах: статус, sku. */
function ozonFetchProductInfoStep_(phaseState) {
  return ozonFetchProductChunkStep_(phaseState, '/v3/product/info/list',
    OZON_CONFIG.cacheSheets.info, 'id',
    (chunk) => ({ product_id: chunk }),
    (i) => ({
      id: i.id, offer_id: i.offer_id, sku: i.sku, fbo_sku: i.fbo_sku, fbs_sku: i.fbs_sku,
      statuses: i.statuses,
      sources: (i.sources || []).map((s) => ({ sku: s.sku })),
      stocks: i.stocks
    }),
    'информация о товарах');
}

/** Атрибуты: габариты, вес, категория/тип. */
function ozonFetchAttributesStep_(phaseState) {
  return ozonFetchProductChunkStep_(phaseState, '/v4/product/info/attributes',
    OZON_CONFIG.cacheSheets.attributes, 'id',
    (chunk) => ({ filter: { product_id: chunk, visibility: 'ALL' }, limit: 1000, sort_dir: 'ASC' }),
    (i) => ({
      id: i.id, offer_id: i.offer_id, sku: i.sku,
      description_category_id: i.description_category_id, type_id: i.type_id,
      depth: i.depth, width: i.width, height: i.height, dimension_unit: i.dimension_unit,
      weight: i.weight, weight_unit: i.weight_unit
    }),
    'атрибуты товаров');
}

/** Цены и комиссии. */
function ozonFetchPricesStep_(phaseState) {
  return ozonFetchProductChunkStep_(phaseState, '/v5/product/info/prices',
    OZON_CONFIG.cacheSheets.prices, 'product_id',
    (chunk) => ({ cursor: '', filter: { product_id: chunk, visibility: 'ALL' }, limit: 1000 }),
    (i) => ({ product_id: i.product_id, offer_id: i.offer_id, price: i.price, commissions: i.commissions }),
    'цены товаров');
}

/**
 * Общий шаг «порция из 1000 product_id». chunkIndex хранится в phaseState.
 * @param slim функция сужения объекта перед записью в кэш
 */
function ozonFetchProductChunkStep_(phaseState, path, sheetName, keyField, payloadFactory, slim, context) {
  const productIds = ozonReadKeys_(OZON_CONFIG.cacheSheets.products).map(Number).filter(Boolean);
  const chunkIndex = Number(phaseState.chunkIndex || 0);
  const chunk = productIds.slice(chunkIndex * 1000, chunkIndex * 1000 + 1000);
  if (!chunk.length) return { done: true };
  const body = ozonRequestJson_(path, payloadFactory(chunk), context);
  const items = body.items || ((body.result || {}).items) || body.result || [];
  ozonAppendObjects_(sheetName, keyField, (Array.isArray(items) ? items : []).map(slim));
  return { done: false, phaseState: { chunkIndex: chunkIndex + 1 } };
}

/** Дерево категорий -> словарь «тип товара» по ключам categoryId:typeId и typeId. Один запрос. */
function ozonFetchCategoryTree_() {
  const body = ozonRequestJson_('/v1/description-category/tree', { language: 'DEFAULT' }, 'дерево категорий');
  const rows = [];
  ozonCollectCategoryTypes_(body.result || [], rows, null);
  ozonWriteObjects_(OZON_CONFIG.cacheSheets.categories, 'key', rows);
}

function ozonCollectCategoryTypes_(nodes, rows, parentCategoryId) {
  (nodes || []).forEach((node) => {
    const hasId = node.description_category_id !== undefined && node.description_category_id !== null;
    const categoryId = hasId ? node.description_category_id : parentCategoryId;
    const typeId = node.type_id;
    const typeName = node.type_name || '';
    if (categoryId !== undefined && categoryId !== null && typeId !== undefined && typeId !== null && typeName) {
      rows.push({ key: categoryId + ':' + typeId, categoryId, typeId, typeName });
      rows.push({ key: String(typeId), categoryId, typeId, typeName });
    }
    ozonCollectCategoryTypes_(node.children || [], rows, categoryId);
  });
}

/** Остатки по складам: schema = 'fbs' | 'fbo'. Порции по 1000 sku + пагинация по cursor. */
function ozonFetchStocksStep_(phaseState, schema) {
  const skuToOffer = ozonBuildSkuToOffer_();
  const skus = Object.keys(skuToOffer);
  const chunkIndex = Number(phaseState.chunkIndex || 0);
  const cursor = phaseState.cursor || '';
  const chunk = skus.slice(chunkIndex * 1000, chunkIndex * 1000 + 1000);
  if (!chunk.length) return { done: true };

  const isFbs = schema === 'fbs';
  const body = ozonRequestJson_(
    isFbs ? '/v2/product/info/stocks-by-warehouse/fbs' : '/v1/product/info/stocks-by-warehouse/fbo',
    { cursor, limit: 1000, [isFbs ? 'sku' : 'skus']: chunk.map((sku) => Number(sku)) },
    'остатки ' + schema.toUpperCase()
  );
  const rows = body.products || ((body.result || {}).products) || [];
  const slim = rows.map((r) => ({
    sku: r.sku,
    offer_id: r.offer_id || skuToOffer[String(r.sku)] || '',
    present: r.present, reserved: r.reserved, free_stock: r.free_stock
  }));
  ozonAppendObjects_(isFbs ? OZON_CONFIG.cacheSheets.fbsStocks : OZON_CONFIG.cacheSheets.fboStocks, 'sku', slim);

  const nextCursor = body.cursor || ((body.result || {}).cursor) || '';
  if (body.has_next && nextCursor && nextCursor !== cursor) {
    return { done: false, phaseState: { chunkIndex, cursor: nextCursor } };
  }
  return { done: false, phaseState: { chunkIndex: chunkIndex + 1, cursor: '' } };
}

/** Финансовый баланс за последние 14 дней (эквайринг, маркетинг, выручка). */
function ozonFetchFinance_() {
  const p = ozonPeriodDaysEndingYesterday_(14);
  const body = ozonRequestJson_('/v1/finance/balance', { date_from: p.dateFrom, date_to: p.dateTo }, 'финансовый баланс');
  ozonWriteObjects_(OZON_CONFIG.cacheSheets.finance, 'key', [{ key: 'finance', body }]);
}

/** Отправления FBO/FBS за `days` дней: по 100 штук на запрос, пагинация по cursor. */
function ozonFetchPostingsStep_(phaseState, schema, days, sheetName) {
  const period = ozonPeriodDateTime_(days);
  const cursor = phaseState.cursor || '';
  const path = schema === 'fbo' ? '/v3/posting/fbo/list' : '/v4/posting/fbs/list';
  const body = ozonRequestJson_(path, {
    cursor,
    filter: { since: period.from, to: period.to },
    limit: 100,
    sort_dir: 'ASC',
    with: { analytics_data: true, financial_data: true }
  }, 'отправления ' + schema.toUpperCase());
  const result = body.result || {};
  const postings = result.postings || body.postings || [];
  ozonAppendObjects_(sheetName, '_key', postings.map((p) => ozonSlimPosting_(p, schema)));
  const nextCursor = result.cursor || body.cursor || '';
  if (postings.length >= 100 && nextCursor && nextCursor !== cursor) {
    return { done: false, phaseState: { cursor: nextCursor } };
  }
  return { done: true };
}

/** Оставляем в отправлении только поля, нужные для расчётов. */
function ozonSlimPosting_(p, schema) {
  const fin = (p.financial_data || {}).products || [];
  return {
    _key: schema + ':' + (p.posting_number || Utilities.getUuid()),
    posting_number: p.posting_number,
    status: p.status,
    created_at: p.created_at, in_process_at: p.in_process_at, shipment_date: p.shipment_date,
    products: (p.products || []).map((x) => ({ offer_id: x.offer_id, sku: x.sku, quantity: x.quantity })),
    financial_data: {
      products: fin.map((x) => ({ product_id: x.product_id, price: x.price, quantity: x.quantity, customer_price: x.customer_price }))
    }
  };
}
