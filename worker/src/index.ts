export interface Env {
  KB_APP_KEY?: string;
  KB_APP_SECRET?: string;
  KB_BASE_URL?: string;
  DASHBOARD_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DART_API_KEY?: string;
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


function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
}

function readXmlTag(xml: string, tag: string): string {
  const localTag = tag.includes(":") ? tag.split(":").pop()! : tag;
  const escaped = localTag.replace(/[.*+?^()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp("<(?:[\\w.-]+:)?" + escaped + "\\b(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?" + escaped + "\\s*>", "i"));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "")) : "";
}

function readXmlLink(xml: string): string {
  const match = xml.match(/<(?:[\w.-]+:)?link\b([^>]*?)>([\s\S]*?)<\/(?:[\w.-]+:)?link\s*>/i);
  const selfClosing = xml.match(/<(?:[\w.-]+:)?link\b([^>]*?)\/>/i);
  const attrs = match?.[1] || selfClosing?.[1] || "";
  const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  return (href || (match ? decodeXml(match[2].replace(/<[^>]+>/g, "")) : "")).trim();
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

    if ((url.pathname === "/api/news" || url.pathname === "/api/market/research" || url.pathname === "/api/market/disclosures" || url.pathname === "/api/ai/compare" || url.pathname === "/api/kb/auth-check" || url.pathname === "/api/kb/holdings" || url.pathname === "/api/kb/deposit" || url.pathname === "/api/kb/valuation") && request.method === "POST") {
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



    if (url.pathname === "/api/market/disclosures" && request.method === "POST") {
      if (!env.DART_API_KEY) return json({ success: false, message: "DART_API_KEY Secret이 설정되지 않았습니다. OpenDART 인증키를 등록해 주세요." }, 503);
      const now = new Date();
      const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const ymd = (date: Date) => date.getUTCFullYear() + String(date.getUTCMonth() + 1).padStart(2, "0") + String(date.getUTCDate()).padStart(2, "0");
      const endDate = ymd(kstNow);
      const startDateObj = new Date(kstNow.getTime() - 2 * 24 * 60 * 60 * 1000);
      const startDate = ymd(startDateObj);
      const params = new URLSearchParams({
        crtfc_key: env.DART_API_KEY,
        bgn_de: startDate,
        end_de: endDate,
        page_no: "1",
        page_count: "100",
        sort: "date",
        sort_mth: "desc",
      });
      try {
        const response = await fetch("https://opendart.fss.or.kr/api/list.json?" + params.toString(), {
          headers: { "Accept": "application/json" },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok) return json({ success: false, stage: "http", http_status: response.status, message: "OpenDART HTTP 오류: " + response.status }, 502);
        if (!contentType.toLowerCase().includes("json")) {
          let safePath = "알 수 없는 응답 경로";
          try { const finalUrl = new URL(response.url); safePath = finalUrl.hostname + finalUrl.pathname; } catch {}
          return json({ success: false, stage: "non_json", http_status: response.status, message: "OpenDART가 JSON 대신 비JSON 응답을 반환했습니다. 최종 응답 경로: " + safePath }, 502);
        }
        const result = await response.json() as {
          status?: string; message?: string; total_count?: number;
          list?: Array<{ corp_name?: string; stock_code?: string; report_nm?: string; rcept_dt?: string; rcept_no?: string; flr_nm?: string; rm?: string }>;
        };
        if (result.status !== "000" && result.status !== "013") {
          return json({ success: false, message: "OpenDART 오류 " + (result.status || "미상") + ": " + (result.message || "응답 확인 필요"), status: result.status }, 502);
        }
        const disclosures = (result.list || []).map(item => ({
          company: item.corp_name || "회사명 없음",
          stock_code: item.stock_code || "",
          title: item.report_nm || "공시 제목 없음",
          date: item.rcept_dt || "",
          receipt_no: item.rcept_no || "",
          reporter: item.flr_nm || "",
          remark: item.rm || "",
          link: item.rcept_no ? "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + item.rcept_no : "",
          listed: Boolean(item.stock_code),
        })).sort((a, b) => Number(b.date) - Number(a.date));
        return json({
          success: true,
          disclosures,
          total_count: result.total_count || disclosures.length,
          date_range: startDate + " ~ " + endDate,
          checked_at: now.toISOString(),
          source: "금융감독원 OpenDART 공시검색 API",
          message: disclosures.length ? "최근 3일 공시 " + disclosures.length + "건을 수집했습니다." : "조회 기간에 공시가 없습니다.",
        });
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        const errorMessage = errorName === "TimeoutError" || errorName === "AbortError" ? "OpenDART 연결 시간이 초과됐습니다." : errorName === "TypeError" ? "OpenDART 외부 연결 또는 TLS 단계에서 실패했습니다." : "OpenDART 요청 처리 중 오류가 발생했습니다.";
        return json({ success: false, stage: "network", error_type: errorName, message: errorMessage + " 인증키와 요청 URL은 보안상 표시하지 않습니다." }, 502);
      }
    }

    if ((url.pathname === "/api/news" || url.pathname === "/api/market/research") && request.method === "POST") {
      const feeds = [
        { category: "국내 증시", source: "연합뉴스 마켓", url: "https://www.yna.co.kr/rss/market.xml" },
        { category: "국내 증시", source: "한국경제 증권", url: "https://www.hankyung.com/feed/finance" },
        { category: "국내 증시", source: "매일경제 증권", url: "https://www.mk.co.kr/rss/30000001/" },
        { category: "경제·금융", source: "연합뉴스 경제", url: "https://www.yna.co.kr/rss/economy.xml" },
        { category: "산업·기업", source: "연합뉴스 산업", url: "https://www.yna.co.kr/rss/industry.xml" },
        { category: "산업·기업", source: "뉴시스 산업", url: "https://www.newsis.com/RSS/industry.xml" },
        { category: "금융·시장", source: "뉴시스 금융", url: "https://www.newsis.com/RSS/bank.xml" },
        { category: "바이오·헬스케어", source: "뉴시스 IT·바이오", url: "https://www.newsis.com/RSS/health.xml" },
        { category: "글로벌 경제", source: "한국경제 국제", url: "https://www.hankyung.com/feed/international" },
        { category: "기술·AI", source: "한국경제 IT", url: "https://www.hankyung.com/feed/it" },
      ];
      const now = new Date();
      const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const year = kstNow.getUTCFullYear();
      const month = kstNow.getUTCMonth() + 1;
      const day = kstNow.getUTCDate();
      const todayKst = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
      const todayStartUtc = Date.UTC(year, month - 1, day) - 9 * 60 * 60 * 1000;
      const feedResults = await Promise.all(feeds.map(async feed => {
        try {
          const response = await fetch(feed.url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; KB-AI-Trader/1.0)", "Accept": "application/rss+xml, application/xml, text/xml" },
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) return { items: [], diagnostic: { source: feed.source, query: feed.category, status: response.status, count: 0, error: "RSS HTTP 오류" } };
          const xml = await response.text();
          const matches = [...xml.matchAll(/<(?:[\w.-]+:)?(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:item|entry)\s*>/gi)].slice(0, 60);
          const parsedItems = matches.map(match => {
            const item = match[1];
            const title = readXmlTag(item, "title");
            const link = readXmlLink(item) || (() => {
              const guid = readXmlTag(item, "guid") || readXmlTag(item, "id");
              return /^https?:\/\//i.test(guid) ? guid : "";
            })();
            const published = readXmlTag(item, "pubDate") || readXmlTag(item, "published") || readXmlTag(item, "updated") || readXmlTag(item, "date");
            const parsed = published ? new Date(published) : null;
            const publishedMs = parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : 0;
            return { title, link, source: feed.source, published_at: publishedMs ? new Date(publishedMs).toISOString() : null, published_ms: publishedMs, query: feed.category, category: feed.category };
          });
          const validItems = parsedItems.filter(item => item.title && /^https?:\/\//i.test(item.link));
          const items = validItems.filter(item => item.published_ms >= todayStartUtc && item.published_ms <= now.getTime());
          const newest = validItems.reduce((latest, item) => Math.max(latest, item.published_ms), 0);
          return { items, diagnostic: { source: feed.source, query: feed.category, status: response.status, raw_count: matches.length, valid_count: validItems.length, count: items.length, newest_published: newest ? new Date(newest).toISOString() : null, sample_title: parsedItems[0]?.title.slice(0, 100) || "", sample_link: parsedItems[0]?.link.slice(0, 160) || "", content_type: response.headers.get("content-type") || "", error: matches.length && !validItems.length ? "RSS 항목은 있으나 제목 또는 링크 추출에 실패했습니다." : matches.length ? null : "RSS/Atom 항목을 찾지 못했습니다." } };
        } catch (error) {
          return { items: [], diagnostic: { source: feed.source, query: feed.category, status: 0, count: 0, error: error instanceof Error ? error.message : "RSS 요청 실패" } };
        }
      }));
      const unique = new Map<string, (typeof feedResults)[number]["items"][number]>();
      for (const result of feedResults) for (const item of result.items) if (!unique.has(item.link)) unique.set(item.link, item);
      const articles = [...unique.values()]
        .sort((a, b) => b.published_ms - a.published_ms)
        .slice(0, 30)
        .map(({ published_ms, ...item }) => item);
      let marketAnalysis = "";
      let analysisError: string | null = null;
      if (articles.length) {
        try {
          const prompt = [
            "너는 한국 주식 단기 스윙 투자자를 돕는 시장 분석 보조자다.",
            "아래는 한국 시간 오늘 발행된 뉴스 제목과 출처다. 제목에 없는 사실이나 주가·거래량·수급 수치를 절대 만들어내지 마라.",
            "뉴스를 바탕으로 1) 시장 분위기 2) 긍정 요인 3) 부정·주의 요인 4) 주목 산업/테마 5) 추가 확인이 필요한 데이터 순서로 한국어 요약하라.",
            "특정 종목의 매수를 단정하지 말고, 뉴스만으로 매수 결정을 내리지 말라고 명시하라.",
            JSON.stringify(articles.map(item => ({ title: item.title, source: item.source, category: item.category, published_at: item.published_at }))),
          ].join("\n");
          const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
            messages: [
              { role: "system", content: "근거 중심의 보수적인 주식시장 분석가다. 제공된 뉴스만 근거로 사용한다." },
              { role: "user", content: prompt },
            ],
            max_tokens: 900,
            temperature: 0.2,
          });
          const output = result && typeof result === "object" ? (result as Record<string, unknown>).response : undefined;
          marketAnalysis = typeof output === "string" ? output : JSON.stringify(result);
        } catch (error) {
          analysisError = error instanceof Error ? error.message.slice(0, 200) : "AI 뉴스 분석 실패";
        }
      }
      return json({
        success: true,
        articles,
        market_analysis: marketAnalysis,
        analysis_error: analysisError,
        diagnostics: feedResults.map(result => result.diagnostic),
        checked_at: now.toISOString(),
        market_date_kst: todayKst,
        date_filter: "KST today 00:00 through checked_at",
        source: "언론사 공식 RSS (연합뉴스·뉴시스·한국경제·매일경제)",
        message: articles.length ? "오늘 발행된 시장 뉴스를 수집했습니다." : "오늘 발행된 뉴스를 찾지 못했습니다. 공급원 상태를 확인해 주세요.",
      });
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
