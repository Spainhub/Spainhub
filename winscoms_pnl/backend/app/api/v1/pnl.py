import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile, status
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import OrgContext, client_ip, org_context, require_org_role
from app.db.session import get_session
from app.financial.pl_template import MANUAL_CATEGORIES, TEMPLATE
from app.models import ManualEntry, OrgSettings, ProductCost, Role, SellerAccount
from app.schemas.pnl import CostOut, ManualEntryIn, ManualEntryOut, SettingsIn, SettingsOut
from app.services import audit, costs, pnl as pnl_service

router = APIRouter(prefix="/orgs/{org_id}", tags=["pnl"])
_admin = require_org_role(Role.admin)
_writer = require_org_role(Role.admin, Role.member)
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# ------------------------------- учётная политика -------------------------------
@router.get("/settings", response_model=SettingsOut | None)
async def get_settings(oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session)):
    return await db.get(OrgSettings, oc.org_id)


@router.put("/settings", response_model=SettingsOut)
async def put_settings(body: SettingsIn, request: Request, oc: OrgContext = Depends(_admin), db: AsyncSession = Depends(get_session)):
    row = await db.get(OrgSettings, oc.org_id)
    if row is None:
        row = OrgSettings(organization_id=oc.org_id)
        db.add(row)
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    row.updated_by, row.updated_at = oc.auth.user.id, datetime.now(timezone.utc)
    audit.record(db, "org_settings.updated", actor=oc.auth.user.id, org=oc.org_id, ip=client_ip(request), tax_regime=body.tax_regime)
    await db.flush()
    return row


# ------------------------------- себестоимость -------------------------------
@router.get("/costs/template")
async def costs_template(oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session)):
    content = costs.build_template(await costs.products_for_template(db, oc.org_id))
    return Response(content, media_type=XLSX, headers={"Content-Disposition": 'attachment; filename="cost_template.xlsx"'})


@router.post("/costs/import")
async def costs_import(
    request: Request, file: UploadFile = File(...), currency: str = Query("RUB", pattern=r"^[A-Z]{3}$"),
    oc: OrgContext = Depends(_writer), db: AsyncSession = Depends(get_session),
):
    content = await file.read(costs.MAX_FILE_BYTES + 1)
    try:
        rows, skipped = costs.parse_workbook(content)
    except costs.CostImportError as e:
        raise HTTPException(422, detail={"message": "Файл не загружен: исправьте ошибки", "errors": e.errors})
    n = await costs.import_costs(db, oc.org_id, oc.auth.user.id, rows, currency)
    audit.record(db, "costs.imported", actor=oc.auth.user.id, org=oc.org_id, ip=client_ip(request), rows=n, skipped=skipped)
    return {"imported": n, "skipped_blank": skipped}


@router.get("/costs", response_model=list[CostOut])
async def list_costs(limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0),
                     oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session)):
    q = select(ProductCost).where(ProductCost.organization_id == oc.org_id).order_by(ProductCost.nm_id, ProductCost.valid_from).limit(limit).offset(offset)
    return list((await db.execute(q)).scalars())


# ------------------------------- ручные записи -------------------------------
def _check_category(cat: str) -> None:
    if cat not in MANUAL_CATEGORIES and cat != "vat_input_purchases":
        raise HTTPException(422, f"Неизвестная категория: {cat}")


async def _check_account(db: AsyncSession, oc: OrgContext, account_id: uuid.UUID | None) -> SellerAccount | None:
    if account_id is None:
        return None
    acc = (await db.execute(select(SellerAccount).where(SellerAccount.id == account_id, SellerAccount.organization_id == oc.org_id))).scalar_one_or_none()
    if acc is None:
        raise HTTPException(404, "Аккаунт не найден")
    return acc


@router.get("/manual-categories")
async def manual_categories(oc: OrgContext = Depends(org_context)):
    return [{"category": c, "name": n} for c, n in {**MANUAL_CATEGORIES, "vat_input_purchases": "НДС по закупкам к вычету (ОСНО)"}.items()]


@router.get("/manual-entries", response_model=list[ManualEntryOut])
async def list_manual(date_from: date | None = None, date_to: date | None = None, category: str | None = None,
                      limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0),
                      oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session)):
    q = select(ManualEntry).where(ManualEntry.organization_id == oc.org_id)
    if date_from:
        q = q.where(ManualEntry.entry_date >= date_from)
    if date_to:
        q = q.where(ManualEntry.entry_date <= date_to)
    if category:
        q = q.where(ManualEntry.category == category)
    return list((await db.execute(q.order_by(ManualEntry.entry_date.desc(), ManualEntry.id.desc()).limit(limit).offset(offset))).scalars())


@router.post("/manual-entries", response_model=ManualEntryOut, status_code=status.HTTP_201_CREATED)
async def create_manual(body: ManualEntryIn, request: Request, oc: OrgContext = Depends(_writer), db: AsyncSession = Depends(get_session)):
    _check_category(body.category)
    acc = await _check_account(db, oc, body.seller_account_id)
    row = ManualEntry(organization_id=oc.org_id, created_by=oc.auth.user.id, marketplace=acc.marketplace if acc else None, **body.model_dump())
    db.add(row)
    await db.flush()
    audit.record(db, "manual_entry.created", actor=oc.auth.user.id, org=oc.org_id, ip=client_ip(request), entry_id=row.id, category=body.category)
    return row


async def _get_manual(db: AsyncSession, oc: OrgContext, entry_id: int) -> ManualEntry:
    row = (await db.execute(select(ManualEntry).where(ManualEntry.id == entry_id, ManualEntry.organization_id == oc.org_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Запись не найдена")
    return row


@router.put("/manual-entries/{entry_id}", response_model=ManualEntryOut)
async def update_manual(entry_id: int, body: ManualEntryIn, request: Request, oc: OrgContext = Depends(_writer), db: AsyncSession = Depends(get_session)):
    _check_category(body.category)
    row = await _get_manual(db, oc, entry_id)
    acc = await _check_account(db, oc, body.seller_account_id)
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    row.marketplace = acc.marketplace if acc else None
    row.updated_at = datetime.now(timezone.utc)
    audit.record(db, "manual_entry.updated", actor=oc.auth.user.id, org=oc.org_id, ip=client_ip(request), entry_id=row.id)
    return row


@router.delete("/manual-entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_manual(entry_id: int, request: Request, oc: OrgContext = Depends(_writer), db: AsyncSession = Depends(get_session)):
    row = await _get_manual(db, oc, entry_id)
    await db.delete(row)
    audit.record(db, "manual_entry.deleted", actor=oc.auth.user.id, org=oc.org_id, ip=client_ip(request), entry_id=entry_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------- отчёт -------------------------------
def _range(date_from: date, date_to: date) -> None:
    if date_to < date_from:
        raise HTTPException(422, "date_to раньше date_from")


@router.get("/reports/pnl")
async def pnl_report(
    date_from: date, date_to: date, granularity: str = Query("month", pattern="^(total|month|day)$"),
    account_id: uuid.UUID | None = None, currency: str | None = Query(None, pattern=r"^[A-Z]{3}$"),
    oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session),
):
    _range(date_from, date_to)
    if account_id:
        (await _check_account(db, oc, account_id))
    return await pnl_service.build_pnl(db, org_id=oc.org_id, account_id=account_id, d1=date_from, d2=date_to,
                                       granularity=granularity, currency=currency)


@router.get("/reports/pnl/drilldown")
async def pnl_drilldown(
    line: str, date_from: date, date_to: date, account_id: uuid.UUID | None = None,
    currency: str = Query("RUB", pattern=r"^[A-Z]{3}$"), limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
    oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session),
):
    """Из чего сложена строка: импортированные транзакции, ручные записи или проданные штуки с применённой себестоимостью."""
    _range(date_from, date_to)
    spec = next((s for s in TEMPLATE if s.id == line), None)
    if spec is None:
        raise HTTPException(404, "Строка не найдена")
    p = {"org": oc.org_id, "d1": date_from, "d2": date_to, "cur": currency, "acc": account_id, "lim": limit, "off": offset}
    acc_sql = "AND {a}.seller_account_id = :acc" if account_id else ""
    if spec.kind == "imported" and spec.line_types:
        rows = (await db.execute(text(f"""
            SELECT fe.id, fe.transaction_id, ft.source_id, fe.entry_date, fe.line_type, fe.amount::text, fe.nm_id,
                   ft.vendor_code, ft.source_operation, ft.bonus_type, ft.status
            FROM financial_entries fe JOIN financial_transactions ft ON ft.id = fe.transaction_id
            WHERE fe.organization_id = :org AND fe.entry_date BETWEEN :d1 AND :d2 AND fe.currency = :cur
              AND fe.line_type = ANY(:types) {acc_sql.format(a='fe')}
            ORDER BY fe.entry_date, fe.id LIMIT :lim OFFSET :off"""), {**p, "types": list(spec.line_types)})).mappings().all()
        return {"line": line, "kind": "import", "items": [dict(r) for r in rows]}
    if spec.kind == "manual":
        q = select(ManualEntry).where(ManualEntry.organization_id == oc.org_id, ManualEntry.category == spec.category,
                                      ManualEntry.entry_date.between(date_from, date_to), ManualEntry.currency == currency)
        if account_id:
            q = q.where(ManualEntry.seller_account_id == account_id)
        rows = (await db.execute(q.order_by(ManualEntry.entry_date, ManualEntry.id).limit(limit).offset(offset))).scalars()
        return {"line": line, "kind": "manual", "items": [ManualEntryOut.model_validate(r).model_dump(mode="json") for r in rows]}
    if spec.kind == "cogs":
        rows = (await db.execute(text(f"""
            SELECT ft.id AS transaction_id, ft.source_id, ft.entry_date, ft.nm_id, ft.vendor_code, ft.quantity,
                   c.cost::text AS cost_per_unit, (ft.quantity * c.cost)::text AS cogs
            FROM financial_transactions ft
            LEFT JOIN LATERAL (SELECT pc.cost_per_unit AS cost FROM product_costs pc
                WHERE pc.organization_id = ft.organization_id AND pc.nm_id = ft.nm_id AND pc.currency = ft.currency
                  AND pc.valid_from <= ft.entry_date ORDER BY pc.valid_from DESC LIMIT 1) c ON true
            WHERE ft.organization_id = :org AND ft.category = 'sale' AND ft.status IN ('ok','review')
              AND ft.entry_date BETWEEN :d1 AND :d2 AND ft.currency = :cur {acc_sql.format(a='ft')}
            ORDER BY ft.entry_date, ft.id LIMIT :lim OFFSET :off"""), p)).mappings().all()
        return {"line": line, "kind": "cogs", "items": [dict(r) for r in rows]}
    raise HTTPException(422, "Для расшифровки выберите листовую строку (импорт, ручная или себестоимость); итоговые строки — формулы над другими строками")
