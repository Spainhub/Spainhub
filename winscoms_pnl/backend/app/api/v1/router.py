from fastapi import APIRouter

from app.api.v1 import admin, auth, health, orgs, seller_accounts

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(admin.router)
api_router.include_router(orgs.router)
api_router.include_router(seller_accounts.router)
