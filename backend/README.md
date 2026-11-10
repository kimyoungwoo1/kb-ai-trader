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
