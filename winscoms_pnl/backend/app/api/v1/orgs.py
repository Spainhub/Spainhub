from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import OrgContext, org_context
from app.db.session import get_session
from app.repositories import memberships as members_repo
from app.schemas.auth import MemberOut

router = APIRouter(prefix="/orgs/{org_id}", tags=["organizations"])


@router.get("/members", response_model=list[MemberOut])
async def list_members(oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session)) -> list[MemberOut]:
    rows = await members_repo.list_members(db, oc.org_id)
    return [MemberOut(user_id=u.id, email=u.email, full_name=u.full_name, role=m.role) for m, u in rows]
