import json
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

    # Match the official KB API Explorer sample structure exactly.
    payload = {
        "dataHeader": {
            "ipAddr": "127.0.0.1",
            "macAddr": "00:00:00:00:00:00",
        },
        "dataBody": {
            "appKey": KB_APP_KEY,
            "appSecret": KB_APP_SECRET,
            "grantType": "client_credentials",
        },
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            # KB's generated Python sample sends the JSON string as the
            # request body and does not add custom headers.
            response = await client.post(
                f"{KB_BASE_URL}/oauth2/token",
                content=__import__("json").dumps(payload, ensure_ascii=False),
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="KB증권 인증 서버 응답 시간이 초과되었습니다.")
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail="KB증권 인증 서버에 연결하지 못했습니다.")

    checked_at = datetime.now(timezone.utc).isoformat()

    try:
        response_data = response.json()
    except ValueError:
        raise HTTPException(
            status_code=502,
            detail=f"KB증권 인증 응답이 JSON이 아닙니다 (HTTP {response.status_code}).",
        )

    # The API specification wraps the result in dataHeader and dataBody.
    header = response_data.get("dataHeader", {}) if isinstance(response_data, dict) else {}
    data = response_data.get("dataBody", {}) if isinstance(response_data, dict) else {}

    if response.status_code != 200 or not data.get("access_token"):
        result_code = header.get("resultCode", "미제공")
        result_message = header.get("resultMessage", "응답 본문 확인 필요")
        process_code = header.get("processCode", "미제공")
        process_message = header.get("processMessage", "")
        # Never expose raw response bodies, credentials, or tokens.
        raise HTTPException(
            status_code=502,
            detail=(
                f"KB증권 토큰 발급 실패 (HTTP {response.status_code}, "
                f"resultCode={result_code}, processCode={process_code}). "
                f"{result_message} {process_message}".strip()
            ),
        )

    # Token is intentionally not persisted or returned in this first connectivity test.
    return AuthCheckResult(
        success=True,
        message="KB증권 인증 성공. 계좌 조회 API 연결은 다음 단계에서 진행합니다.",
        token_type=data.get("token_type", "Bearer"),
        expires_in=data.get("expires_in"),
        checked_at=checked_at,
    )


async def issue_kb_access_token(client: httpx.AsyncClient) -> str:
    """Issue a short-lived token without persisting or returning it."""
    if not KB_APP_KEY or not KB_APP_SECRET:
        raise HTTPException(
            status_code=503,
            detail="KB_APP_KEY 또는 KB_APP_SECRET 환경변수가 설정되지 않았습니다.",
        )

    token_payload = {
        "dataHeader": {
            "ipAddr": "127.0.0.1",
            "macAddr": "00:00:00:00:00:00",
        },
        "dataBody": {
            "appKey": KB_APP_KEY,
            "appSecret": KB_APP_SECRET,
            "grantType": "client_credentials",
        },
    }
    token_response = await client.post(
        f"{KB_BASE_URL}/oauth2/token",
        content=json.dumps(token_payload, ensure_ascii=False),
    )
    try:
        token_result = token_response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="KB증권 토큰 응답을 JSON으로 해석할 수 없습니다.")

    token_body = token_result.get("dataBody", {}) if isinstance(token_result, dict) else {}
    access_token = token_body.get("access_token")
    if token_response.status_code != 200 or not access_token:
        token_header = token_result.get("dataHeader", {}) if isinstance(token_result, dict) else {}
        raise HTTPException(
            status_code=502,
            detail=(
                "KB증권 토큰 발급 실패: "
                f"resultCode={token_header.get('resultCode', '미제공')}, "
                f"processCode={token_header.get('processCode', '미제공')}, "
                f"{token_header.get('processMessage', token_header.get('resultMessage', '응답 확인 필요'))}"
            ),
        )
    return access_token


@app.post("/api/kb/holdings")
async def kb_holdings():
    """Read domestic stock holdings. This endpoint cannot place orders."""
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            access_token = await issue_kb_access_token(client)
            request_payload = {
                "dataHeader": {
                    "ipAddr": "127.0.0.1",
                    "macAddr": "00:00:00:00:00:00",
                },
                "dataBody": {
                    "mkt_tm_ccd": "1",
                    "nxt_key": "",
                    "inq_clsf": "0",
                    "is_no": "",
                },
            }
            response = await client.post(
                f"{KB_BASE_URL}/api/v1/ssqm1801",
                content=json.dumps(request_payload, ensure_ascii=False),
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                },
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="KB증권 보유주식 조회 응답 시간이 초과되었습니다.")
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail="KB증권 API 서버에 연결하지 못했습니다.")

    try:
        result = response.json()
    except ValueError:
        raise HTTPException(
            status_code=502,
            detail=f"KB증권 보유주식 조회 응답이 JSON이 아닙니다 (HTTP {response.status_code}).",
        )

    if response.status_code != 200:
        header = result.get("dataHeader", {}) if isinstance(result, dict) else {}
        raise HTTPException(
            status_code=502,
            detail=(
                f"KB증권 보유주식 조회 실패 (HTTP {response.status_code}, "
                f"resultCode={header.get('resultCode', '미제공')}, "
                f"processCode={header.get('processCode', '미제공')}). "
                f"{header.get('processMessage', header.get('resultMessage', '응답 확인 필요'))}"
            ),
        )

    # Return the broker's holdings response for field mapping. The OAuth token is never returned.
    return {"success": True, "api": "SSQM1801", "data": result}
