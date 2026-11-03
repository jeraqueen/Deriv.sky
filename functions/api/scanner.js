export async function onRequest({ request, env }) {
  if (!env.MARKET_ENGINE) {
    return Response.json({ ok: false, error: "Background scanner binding is not configured yet." }, { status: 503 });
  }
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  const allowed = new Set(["status", "start", "stop", "test"]);
  if (!allowed.has(action)) return Response.json({ ok: false, error: "Unsupported scanner action." }, { status: 400 });
  if (action !== "status" && action !== "test" && request.method !== "POST") {
    return Response.json({ ok: false, error: "POST is required for this action." }, { status: 405 });
  }
  const id = env.MARKET_ENGINE.idFromName("sky-bot-volatility-scanner");
  const stub = env.MARKET_ENGINE.get(id);
  return stub.fetch("https://engine/" + action, { method: "POST" });
}
