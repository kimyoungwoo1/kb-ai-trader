import os
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

KB_BASE_URL = os.getenv("KB_BASE_URL", "https://developer.kbsec.com:32484").rstrip("/")
KB_APP_KEY = os.getenv("KB_APP_KEY", "")
KB_APP_SECRET = os.getenv("KB_APP_SECRET", "")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

app = FastAPI(
    title="KB AI Trader API",
    version="0.1.0",
    description="Read-only account integration foundation. No order endpoints are implemented.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN, "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class AuthCheckResult(BaseModel):
    success: bool
    message: str
    token_type: str | None = None
    expires_in: int | None = None
    checked_at: str


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "kb-ai-trader-api", "orders_enabled": False}


@app.post("/api/kb/auth-check", response_model=AuthCheckResult)
async def kb_auth_check():
    """Validate KB credentials and discard the access token; never return secrets/token."""
    if not KB_APP_KEY or not KB_APP_SECRET:
        raise HTTPException(
            status_code=503,
            detail="KB_APP_KEY 또는 KB_APP_SECRET 환경변수가 설정되지 않았습니다.",
        )

    payload = {
        "grantType": "client_credentials",
        "appKey": KB_APP_KEY,
        "appSecret": KB_APP_SECRET,
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                f"{KB_BASE_URL}/oauth2/token",
                json=payload,
                headers={"Content-Type": "application/json"},
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="KB증권 인증 서버 응답 시간이 초과되었습니다.")
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail="KB증권 인증 서버에 연결하지 못했습니다.")

    checked_at = datetime.now(timezone.utc).isoformat()

    if response.status_code != 200:
        # Do not expose request payload, credentials, or raw response body.
        raise HTTPException(
            status_code=502,
            detail=f"KB증권 토큰 발급 실패 (HTTP {response.status_code}). API 신청 권한과 인증정보를 확인하세요.",
        )

    try:
        data = response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="KB증권 인증 응답을 JSON으로 해석하지 못했습니다.")

    if not data.get("access_token"):
        raise HTTPException(status_code=502, detail="인증 응답에 access_token이 없습니다.")

    # Token is intentionally not persisted or returned in this first connectivity test.
    return AuthCheckResult(
        success=True,
        message="KB증권 인증 성공. 계좌 조회 API 연결은 다음 단계에서 진행합니다.",
        token_type=data.get("token_type", "Bearer"),
        expires_in=data.get("expires_in"),
        checked_at=checked_at,
    )
