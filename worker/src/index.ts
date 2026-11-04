export interface Env {
  // KB Open API credentials will be added as Cloudflare Worker secrets.
  KB_APP_KEY?: string;
  KB_APP_SECRET?: string;
}

const json = (data: unknown, status = 200): Response =>
  Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        success: true,
        service: "kb-ai-trader-api",
        status: "healthy",
        checked_at: new Date().toISOString(),
      });
    }

    return json({ success: false, message: "Not Found" }, 404);
  },
};
