export interface Env {
  KB_APP_KEY?: string;
  KB_APP_SECRET?: string;
  KB_BASE_URL?: string;
  DASHBOARD_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ASSETS: Fetcher;
  AI: Ai;
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

    if ((url.pathname === "/api/ai/compare" || url.pathname === "/api/kb/auth-check" || url.pathname === "/api/kb/holdings" || url.pathname === "/api/kb/deposit" || url.pathname === "/api/kb/valuation") && request.method === "POST") {
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


    if (url.pathname === "/api/ai/compare" && request.method === "POST") {
      let input: { holdings?: unknown; accountSummary?: unknown };
      try { input = await request.json() as { holdings?: unknown; accountSummary?: unknown }; }
      catch { return json({ success: false, message: "요청 데이터 형식이 올바르지 않습니다." }, 400); }

      if (!Array.isArray(input.holdings) || input.holdings.length > 50) {
        return json({ success: false, message: "분석할 보유 종목 데이터가 올바르지 않습니다." }, 400);
      }

      const holdings = input.holdings.map((item: any) => ({
        name: String(item?.name || "").slice(0, 80),
        code: String(item?.code || "").slice(0, 20),
        quantity: Number(item?.quantity) || 0,
        averagePrice: Number(item?.averagePrice) || 0,
        currentPrice: Number(item?.currentPrice) || 0,
        valuation: Number(item?.valuation) || 0,
        profitLoss: Number(item?.profitLoss) || 0,
        yieldRate: Number(item?.yieldRate) || 0,
      }));
      const summary = input.accountSummary && typeof input.accountSummary === "object"
        ? input.accountSummary as Record<string, unknown>
        : {};

      const prompt = [
        "다음은 사용자의 실제 보유 종목 및 계좌 요약 데이터다. 한국어로 개인 투자자용 포트폴리오 진단을 작성하라.",
        "제공된 숫자만 사용하고 현재 시세, 뉴스, 공시, 기업 실적을 알고 있는 것처럼 말하지 마라. 데이터에 없는 정보는 확인 불가라고 명시하라.",
        "개별 종목별 손익 상태와 집중 위험을 설명하되 매수·매도 명령이 아니라 참고 의견으로 제시하라.",
        "응답 형식: 1) 계좌 전체 진단 2) 종목별 점검 3) 리스크와 주의점 4) 다음에 확인할 데이터.",
        "단기 스윙 관점으로 설명하되 실시간 시장 데이터가 없으므로 구체적인 신규 진입가·목표가·손절가는 만들지 마라.",
        "계좌 요약: " + JSON.stringify(summary),
        "보유 종목: " + JSON.stringify(holdings),
      ].join("\n");

      if (!env.GEMINI_API_KEY) return json({ success: false, message: "GEMINI_API_KEY Secret이 설정되지 않았습니다." }, 503);
      const systemInstruction = "너는 보수적인 한국 주식 포트폴리오 분석 보조자다. 근거 없는 확신과 허위 시세를 만들지 않는다. 두 모델의 비교를 위해 각 보유 종목에 대해 반드시 종목코드, 판단(긍정/중립/주의), 근거를 명시하고 데이터가 부족하면 중립으로 판단하라.";
      const [cloudflareResult, geminiResponse] = await Promise.all([
        env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt },
          ],
          max_tokens: 1400,
          temperature: 0.2,
        }),
        (async () => {
          const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY!);
          const body = JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1400, thinkingConfig: { thinkingLevel: "medium" } },
          });
          let response: Response | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(resolve => setTimeout(resolve, attempt * 1200));
            response = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              signal: AbortSignal.timeout(20000),
            });
            if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) break;
          }
          return response!;
        })(),
      ]);
      const cloudflareOutput = cloudflareResult && typeof cloudflareResult === "object"
        ? (cloudflareResult as Record<string, unknown>).response
        : undefined;
      let geminiData: any = {};
      try { geminiData = await geminiResponse.json(); } catch {}
      const geminiOutput = geminiData?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("\n") || "";
      return json({
        success: true,
        results: {
          cloudflare: {
            success: typeof cloudflareOutput === "string",
            model: "@cf/meta/llama-3.1-8b-instruct-fp8",
            analysis: typeof cloudflareOutput === "string" ? cloudflareOutput : JSON.stringify(cloudflareResult),
          },
          gemini: {
            success: geminiResponse.ok && Boolean(geminiOutput),
            model: "gemini-3.8-flash",
            analysis: geminiResponse.ok ? geminiOutput : `HTTP ${geminiResponse.status}: ${geminiData?.error?.message || "Gemini API가 상세 오류를 반환하지 않았습니다."}`,
            error_code: geminiData?.error?.status || null,
            http_status: geminiResponse.status,
          },
        },
        checked_at: new Date().toISOString(),
        data_scope: "현재 계좌 보유 데이터만 분석; 실시간 시세·뉴스 미포함",
      });
    }

    if (url.pathname.startsWith("/api/")) return json({ success: false, message: "Not Found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
