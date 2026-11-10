# Backend

FastAPI service for the KB AI Trader dashboard.

## Setup in Codespaces

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and enter your KB App Key and App Secret locally in Codespaces.
Do not commit `.env`, paste credentials into chat, or expose them to frontend code.

## Run

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Health: `GET /api/health`

Credential check: `POST /api/kb/auth-check`

This milestone only tests OAuth authentication. It does not implement or expose any buy/sell order endpoint.

## Windows account relay for intermittent Worker → KB failures

The optional relay handles only holdings, valuation, and cash. The PC uses its
own KB OAuth credentials and returns account results to the authenticated
Worker. Order submission, cancellation, risk checks, and market data continue
to use their existing paths.

1. In `backend/.env` on the Windows PC, set `KB_APP_KEY`, `KB_APP_SECRET`, and
   `KB_ACCOUNT_RELAY_TOKEN` (a randomly generated secret of at least 32 characters).
2. From the `backend` directory, install `requirements.txt` in your virtual
   environment and run:
   ```powershell
   python -m uvicorn kb_account_relay:app --host 127.0.0.1 --port 8788
   ```
3. Map an HTTPS hostname you control to `http://127.0.0.1:8788` using a Cloudflare
   Tunnel. Keep the relay bound to loopback. The relay requires the bearer token
   for each account request and accepts no caller-supplied KB URL or payload.
4. In the deployment environment, securely set `KB_ACCOUNT_RELAY_ORIGIN` (HTTPS
   origin with no path or trailing slash) and `KB_ACCOUNT_RELAY_TOKEN` (same as
   the PC). Run the usual verified deployment. The candidate must pass holdings
   and valuation through the relay before traffic switches. Later deployments
   inherit both bindings. Without either binding, the Worker uses direct reads.
