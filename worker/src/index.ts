export interface Env {
  KB_APP_KEY?: string;
  KB_APP_SECRET?: string;
  KB_BASE_URL?: string;
  DASHBOARD_API_KEY?: string;
  ASSETS: Fetcher;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: corsHeaders });

function getKbErrorMessage(result: unknown): string {
  if (!result || typeof result !== "object") return "응답 형식을 확인할 수 없습니다.";
  const header = (result as Record<string, unknown>).dataHeader;
  if (!header || typeof header !== "object") return "KB증권 응답에 오류 정보가 없습니다.";
  const h = header as Record<string, unknown>;
  const code = h.resultCode ?? "미제공";
  const processCode = h.processCode ?? "미제공";
  const message = h.processMessage ?? h.resultMessage ?? "응답 확인 필요";
  return `resultCode=${String(code)}, processCode=${String(processCode)}. ${String(message)}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        success: true,
        service: "kb-ai-trader-api",
        status: "healthy",
        checked_at: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      if (!env.DASHBOARD_API_KEY) return json({ success: false, message: "DASHBOARD_API_KEY Secret이 설정되지 않았습니다." }, 503);
      let input: { password?: string };
      try { input = await request.json() as { password?: string }; }
      catch { return json({ success: false, message: "요청 형식이 올바르지 않습니다." }, 400); }
      if (typeof input.password !== "string" || input.password !== env.DASHBOARD_API_KEY) {
        return json({ success: false, message: "비밀번호가 올바르지 않습니다." }, 401);
      }
      return json({ success: true, token: env.DASHBOARD_API_KEY });
    }

    if ((url.pathname === "/api/kb/auth-check" || url.pathname === "/api/kb/holdings" || url.pathname === "/api/kb/deposit") && request.method === "POST") {
      const authorization = request.headers.get("Authorization") || "";
      if (!env.DASHBOARD_API_KEY || authorization !== `Bearer ${env.DASHBOARD_API_KEY}`) {
        return json({ success: false, message: "로그인이 필요합니다." }, 401);
      }
    }
    if (url.pathname === "/api/kb/auth-check" && request.method === "POST") {
      if (!env.KB_APP_KEY || !env.KB_APP_SECRET) {
        return json({
          success: false,
          message: "Cloudflare Worker Secret KB_APP_KEY와 KB_APP_SECRET을 먼저 설정해야 합니다.",
        }, 503);
      }

      const baseUrl = (env.KB_BASE_URL || "https://developer.kbsec.com:32484").replace(/\/$/, "");
      const payload = {
        dataHeader: {
          ipAddr: "127.0.0.1",
          macAddr: "00:00:00:00:00:00",
        },
        dataBody: {
          appKey: env.KB_APP_KEY,
          appSecret: env.KB_APP_SECRET,
          grantType: "client_credentials",
        },
      };

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/oauth2/token`, {
          method: "POST",
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "네트워크 요청 실패";
        return json({
          success: false,
          stage: "network",
          message: "Cloudflare Worker에서 KB증권 인증 서버에 연결하지 못했습니다.",
          detail: detail.slice(0, 300),
          checked_at: new Date().toISOString(),
        }, 502);
      }

      let result: unknown;
      try {
        result = await response.json();
      } catch {
        return json({
          success: false,
          stage: "response",
          message: `KB증권 응답이 JSON 형식이 아닙니다. HTTP ${response.status}`,
          checked_at: new Date().toISOString(),
        }, 502);
      }

      const body = result && typeof result === "object"
        ? (result as Record<string, unknown>).dataBody
        : undefined;
      const tokenData = body && typeof body === "object"
        ? body as Record<string, unknown>
        : {};
      const accessToken = tokenData.access_token;

      if (!response.ok || typeof accessToken !== "string" || accessToken.length === 0) {
        return json({
          success: false,
          stage: "authentication",
          http_status: response.status,
          message: getKbErrorMessage(result),
          checked_at: new Date().toISOString(),
        }, 502);
      }

      // Never return or persist the access token or the app credentials.
      return json({
        success: true,
        message: "KB증권 OAuth 인증에 성공했습니다.",
        token_type: tokenData.token_type ?? "Bearer",
        expires_in: tokenData.expires_in ?? null,
        checked_at: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/kb/holdings" && request.method === "POST") {
      if (!env.KB_APP_KEY || !env.KB_APP_SECRET) {
        return json({ success: false, message: "KB_APP_KEY 또는 KB_APP_SECRET이 설정되지 않았습니다." }, 503);
      }

      const baseUrl = (env.KB_BASE_URL || "https://developer.kbsec.com:32484").replace(/\/$/, "");
      let tokenResponse: Response;
      try {
        tokenResponse = await fetch(`${baseUrl}/oauth2/token`, {
          method: "POST",
          body: JSON.stringify({
            dataHeader: { ipAddr: "127.0.0.1", macAddr: "00:00:00:00:00:00" },
            dataBody: {
              appKey: env.KB_APP_KEY,
              appSecret: env.KB_APP_SECRET,
              grantType: "client_credentials",
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        return json({
          success: false,
          stage: "token_network",
          message: error instanceof Error ? error.message.slice(0, 250) : "KB 토큰 서버 연결 실패",
        }, 502);
      }

      let tokenResult: unknown;
      try {
        tokenResult = await tokenResponse.json();
      } catch {
        return json({ success: false, stage: "token_response", message: "KB 토큰 응답이 JSON이 아닙니다." }, 502);
      }

      const tokenBody = tokenResult && typeof tokenResult === "object"
        ? (tokenResult as Record<string, unknown>).dataBody
        : undefined;
      const tokenData = tokenBody && typeof tokenBody === "object"
        ? tokenBody as Record<string, unknown>
        : {};
      const accessToken = tokenData.access_token;

      if (!tokenResponse.ok || typeof accessToken !== "string" || !accessToken) {
        return json({
          success: false,
          stage: "authentication",
          http_status: tokenResponse.status,
          message: getKbErrorMessage(tokenResult),
        }, 502);
      }

      let holdingsResponse: Response;
      try {
        holdingsResponse = await fetch(`${baseUrl}/api/v1/ssqm1801`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dataHeader: { ipAddr: "127.0.0.1", macAddr: "00:00:00:00:00:00" },
            dataBody: { mkt_tm_ccd: "1", nxt_key: "", inq_clsf: "0", is_no: "" },
          }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        return json({
          success: false,
          stage: "holdings_network",
          message: error instanceof Error ? error.message.slice(0, 250) : "보유주식 API 연결 실패",
        }, 502);
      }

      let holdingsResult: unknown;
      try {
        holdingsResult = await holdingsResponse.json();
      } catch {
        return json({
          success: false,
          stage: "holdings_response",
          http_status: holdingsResponse.status,
          message: "KB 보유주식 응답이 JSON이 아닙니다.",
        }, 502);
      }

      if (!holdingsResponse.ok) {
        return json({
          success: false,
          stage: "holdings",
          http_status: holdingsResponse.status,
          message: getKbErrorMessage(holdingsResult),
        }, 502);
      }

      return json({
        success: true,
        api: "SSQM1801",
        message: "보유주식 조회 요청이 성공했습니다.",
        data: holdingsResult,
        checked_at: new Date().toISOString(),
      });
    }


    if (url.pathname === "/api/kb/deposit" && request.method === "POST") {
      if (!env.KB_APP_KEY || !env.KB_APP_SECRET) {
        return json({ success: false, message: "KB_APP_KEY 또는 KB_APP_SECRET이 설정되지 않았습니다." }, 503);
      }
      const baseUrl = (env.KB_BASE_URL || "https://developer.kbsec.com:32484").replace(/\/$/, "");
      let tokenResponse: Response;
      try {
        tokenResponse = await fetch(`${baseUrl}/oauth2/token`, {
          method: "POST",
          body: JSON.stringify({
            dataHeader: { ipAddr: "127.0.0.1", macAddr: "00:00:00:00:00:00" },
            dataBody: { appKey: env.KB_APP_KEY, appSecret: env.KB_APP_SECRET, grantType: "client_credentials" },
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        return json({ success: false, stage: "token_network", message: error instanceof Error ? error.message.slice(0, 250) : "KB 토큰 서버 연결 실패" }, 502);
      }
      let tokenResult: unknown;
      try { tokenResult = await tokenResponse.json(); }
      catch { return json({ success: false, stage: "token_response", message: "KB 토큰 응답이 JSON이 아닙니다." }, 502); }
      const tokenBody = tokenResult && typeof tokenResult === "object" ? (tokenResult as Record<string, unknown>).dataBody : undefined;
      const tokenData = tokenBody && typeof tokenBody === "object" ? tokenBody as Record<string, unknown> : {};
      const accessToken = tokenData.access_token;
      if (!tokenResponse.ok || typeof accessToken !== "string" || !accessToken) {
        return json({ success: false, stage: "authentication", http_status: tokenResponse.status, message: getKbErrorMessage(tokenResult) }, 502);
      }
      let depositResponse: Response;
      try {
        depositResponse = await fetch(`${baseUrl}/api/v1/ssqm0004`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            dataHeader: { ipAddr: "127.0.0.1", macAddr: "00:00:00:00:00:00" },
            dataBody: {},
          }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        return json({ success: false, stage: "deposit_network", message: error instanceof Error ? error.message.slice(0, 250) : "예수금 API 연결 실패" }, 502);
      }
      let depositResult: unknown;
      try { depositResult = await depositResponse.json(); }
      catch { return json({ success: false, stage: "deposit_response", http_status: depositResponse.status, message: "KB 예수금 응답이 JSON이 아닙니다." }, 502); }
      if (!depositResponse.ok) {
        return json({ success: false, stage: "deposit", http_status: depositResponse.status, message: getKbErrorMessage(depositResult), data: depositResult }, 502);
      }
      return json({ success: true, api: "SSQM0004", message: "예수금내역 조회 요청이 성공했습니다.", data: depositResult, checked_at: new Date().toISOString() });
    }


    if (url.pathname === "/api/kb/valuation" && request.method === "POST") {
      if (!env.KB_APP_KEY || !env.KB_APP_SECRET) return json({ success: false, message: "KB_APP_KEY 또는 KB_APP_SECRET이 설정되지 않았습니다." }, 503);
      const baseUrl = (env.KB_BASE_URL || "https://developer.kbsec.com:32484").replace(/\/$/, "");
      let tokenResponse: Response;
      try {
        tokenResponse = await fetch(`${baseUrl}/oauth2/token`, {
          method: "POST",
          body: JSON.stringify({
            dataHeader: { ipAddr: "127.0.0.1", macAddr: "00:00:00:00:00:00" },
            dataBody: { appKey: env.KB_APP_KEY, appSecret: env.KB_APP_SECRET, grantType: "client_credentials" },
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        return json({ success: false, stage: "token_network", message: error instanceof Error ? error.message.slice(0, 250) : "KB 토큰 서버 연결 실패" }, 502);
      }
      let tokenResult: unknown;
      try { tokenResult = await tokenResponse.json(); }
      catch { return json({ success: false, stage: "token_response", message: "KB 토큰 응답이 JSON이 아닙니다." }, 502); }
      const tokenBody = tokenResult && typeof tokenResult === "object" ? (tokenResult as Record<string, unknown>).dataBody : undefined;
      const tokenData = tokenBody && typeof tokenBody === "object" ? tokenBody as Record<string, unknown> : {};
      const accessToken = tokenData.access_token;
      if (!tokenResponse.ok || typeof accessToken !== "string" || !accessToken) {
        return json({ success: false, stage: "authentication", http_status: tokenResponse.status, message: getKbErrorMessage(tokenResult) }, 502);
      }
      let valuationResponse: Response;
      try {
        valuationResponse = await fetch(`${baseUrl}/api/v1/ssqm2952`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            dataHeader: { ipAddr: "127.0.0.1", macAddr: "00:00:00:00:00:00" },
            dataBody: { excg_mktpr_ccd: "A" },
          }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        return json({ success: false, stage: "valuation_network", message: error instanceof Error ? error.message.slice(0, 250) : "계좌자산평가 API 연결 실패" }, 502);
      }
      let valuationResult: unknown;
      try { valuationResult = await valuationResponse.json(); }
      catch { return json({ success: false, stage: "valuation_response", http_status: valuationResponse.status, message: "KB 계좌자산평가 응답이 JSON이 아닙니다." }, 502); }
      if (!valuationResponse.ok) {
        return json({ success: false, stage: "valuation", http_status: valuationResponse.status, message: getKbErrorMessage(valuationResult), data: valuationResult }, 502);
      }
      return json({ success: true, api: "SSQM2952", message: "계좌자산평가 조회 요청이 성공했습니다.", data: valuationResult, checked_at: new Date().toISOString() });
    }

    if (url.pathname.startsWith("/api/")) return json({ success: false, message: "Not Found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
