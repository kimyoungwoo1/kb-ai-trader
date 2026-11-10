"""Private, read-only KB account relay. Bind to loopback behind an HTTPS tunnel."""
import asyncio
import hmac
import os
import time
from pathlib import Path
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

load_dotenv(Path(__file__).resolve().with_name(".env"))
KB_ORIGIN = "https://developer.kbsec.com:32484"
ROUTES = {
    "holdings": ("ssqm1801", {"mkt_tm_ccd": "1", "nxt_key": "", "inq_clsf": "0", "is_no": ""}),
    "valuation": ("ssqm2952", {"excg_mktpr_ccd": "A"}),
    "deposit": ("ssqm0004", {}),
}
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
token_lock = asyncio.Lock()
cached_token = ("", 0.0)


def kb_payload(body):
    return {"dataHeader": {"ipAddr": "127.0.0.1", "macAddr": "00:00:00:00:00:00"}, "dataBody": body}


def fail(status, stage, kb_status=None):
    return JSONResponse({"success": False, "stage": stage, "kb_status": kb_status},
                        status_code=status, headers={"Cache-Control": "no-store"})


async def access_token(client):
    global cached_token
    async with token_lock:
        if cached_token[1] > time.monotonic():
            return cached_token[0], None
        key, secret = os.getenv("KB_APP_KEY"), os.getenv("KB_APP_SECRET")
        if not key or not secret:
            return None, fail(503, "relay_configuration")
        response = await client.post(KB_ORIGIN + "/oauth2/token", json=kb_payload({
            "appKey": key, "appSecret": secret, "grantType": "client_credentials",
        }))
        if not response.is_success:
            return None, fail(502, "relay_oauth", response.status_code)
        data = response.json().get("dataBody") or {}
        token = data.get("access_token")
        if not isinstance(token, str) or not token:
            return None, fail(502, "relay_oauth", response.status_code)
        lifetime = data.get("expires_in")
        ttl = min(int(lifetime), 28800) if str(lifetime).isdigit() else 300
        cached_token = (token, time.monotonic() + max(0, ttl - 60))
        return token, None


@app.post("/account/{kind}")
async def account(kind: Literal["holdings", "valuation", "deposit"], authorization: str = Header("")):
    global cached_token
    secret = os.getenv("KB_ACCOUNT_RELAY_TOKEN", "")
    if len(secret) < 32 or not hmac.compare_digest(authorization.encode(), ("Bearer " + secret).encode()):
        raise HTTPException(status_code=401, detail="Unauthorized", headers={"Cache-Control": "no-store"})
    path, body = ROUTES[kind]
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            token, error = await access_token(client)
            if error is not None:
                return error
            response = await client.post(KB_ORIGIN + "/api/v1/" + path,
                                         headers={"Authorization": "Bearer " + token},
                                         json=kb_payload(body))
        if response.status_code == 401:
            async with token_lock:
                if cached_token[0] == token:
                    cached_token = ("", 0.0)
        if not response.is_success:
            return fail(502, "relay_kb_response", response.status_code)
        data = response.json()
        header = data.get("dataHeader") or {}
        if str(header.get("resultCode")) != "200" or header.get("processFlag") != "A":
            return fail(502, "relay_kb_business", response.status_code)
        if not isinstance(data.get("dataBody"), dict):
            return fail(502, "relay_kb_format", response.status_code)
        return JSONResponse({"success": True, "data": data},
                            headers={"Cache-Control": "no-store"})
    except httpx.TimeoutException:
        return fail(504, "relay_timeout")
    except httpx.RequestError:
        return fail(502, "relay_connection")
    except (ValueError, TypeError, AttributeError):
        return fail(502, "relay_kb_format")
