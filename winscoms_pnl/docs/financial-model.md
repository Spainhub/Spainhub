# Нормализованная финансовая модель (Stage 6)

```
raw_records (JSONB, как пришло)  ──1:1──▶  financial_transactions  ──1:N──▶  financial_entries
                                          (кто/что/когда/статус)             (line_type, amount NUMERIC(20,6))
```
Движок P&L (Stage 7) читает **только `financial_entries`** и ничего не знает про поля конкретного маркетплейса.
Новый маркетплейс = адаптер `integrations/<mp>/mapper.py` + строка в `integrations/registry.py` + тесты.

## Время и даты
- `entry_date` — дата строки отчёта (`rrDate`, **по Москве**, тип `date`); периоды P&L считаются по ней.
- Моменты времени в БД (`created_at`, `normalized_at`, …) — UTC `timestamptz`.
- Дата отчёта WB и учётный период не одно и то же: отнесение к месяцу делается при построении отчёта.

## Статусы строки (`financial_transactions.status`)
| статус | значение | попадает в P&L |
|---|---|---|
| `ok` | тип известен, проверки сошлись | да |
| `review` | суммы сохранены, но смысл/знак не подтверждён (неизвестный `bonusTypeName`, `quantity ≠ 1`, возмещение издержек, неописанное денежное поле) | только `line_type` с nature revenue/expense; `pending` — нет |
| `inconsistent` | не хватает обязательных полей, число не разобралось или не сошлась арифметика (`forPay`, комиссия); без даты/валюты строк-сумм нет | суммы показываются с предупреждением о неполных данных |
| `unclassified` | неизвестный `sellerOperName` (например, «Возврат» — знак не подтверждён) | нет; ненулевые суммы сохранены как `unmapped:<поле>` |

`GET /api/v1/orgs/{org}/seller-accounts/{id}/normalization` — сколько строк в каждом статусе и категории; `needs_attention` > 0 означает, что отчёт неполный. Пропуски не превращаются в нули.

## Каталог `line_type` (`app/financial/model.py`)
| line_type | источник WB | nature | комментарий |
|---|---|---|---|
| `sale_revenue` | `retailPriceWithDisc` | revenue | выручка по выбранной политике |
| `commission_gross` | `vw+vwNds+ppvzReward+(retailPrice−retailAmount)` | expense | = `retailPrice×commissionPercent/100`; проверяется |
| `acquiring` | `acquiringFee` | expense | |
| `sale_buyer_amount`, `spp_compensation`, `commission_vat`, `for_pay` | `retailAmount`, `retailPrice−retailAmount`, `vwNds`, `forPay` | info | для сверки/расшифровки, в P&L не суммируются |
| `logistics_to_customer_sale` / `_cancel`, `logistics_from_customer_cancel`, `logistics_other` | `deliveryService` по `bonusTypeName` | expense | |
| `storage`, `acceptance` | `paidStorage`, `paidAcceptance` | expense | |
| `advertising` | `deduction`, `bonusTypeName` начинается с «Оказание услуг «WB Продвижение»» | expense | |
| `deduction_other` | прочие `deduction` | expense | |
| `rebill_logistics_cost`, `rebill_commission_credit` | `rebillLogisticCost`, `vw+vwNds` | pending | ждёт решения (см. findings §3) |
| `penalty`, `additional_payment`, `unmapped:*` | соответствующие поля | pending | знак не подтверждён данными |

Знак: расходные типы положительны, когда это расход; отрицательное значение — кредит.

## Правила и гарантии
- Отсутствующее поле — «нет данных», не 0; затронутые вычисления пропускаются, строка получает `inconsistent`.
- Деньги — `Decimal(str(значение))`, хранение `NUMERIC(20,6)`, округление при записи — банковское до 6 знаков; итоговое округление отчёта — отдельное правило Stage 7.
- Нормализатор не бросает исключений (ошибка → `issues`), поэтому синхронизация не падает из-за странной строки.
- Нормализация идёт в той же транзакции, что и сохранение страницы сырых данных; повтор идемпотентен (`uq_financial_transactions_raw_record_id`, строки пересоздаются).
- `NORMALIZER_VERSION` повышается при смене правил: при следующей загрузке/дозапуске строки с меньшей версией пересчитываются из `raw_records` (без повторных запросов к WB).
- Таблицы под RLS по организации (см. docs/auth.md).
