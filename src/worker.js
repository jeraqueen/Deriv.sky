const DERIV_API = "https://api.derivws.com";
const DERIV_AUTH = "https://auth.deriv.com/oauth2";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/oauth/token" && request.method === "POST") {
      try {
        const { code, code_verifier, redirect_uri } = await request.json();
        if (!code || !code_verifier || !redirect_uri) return json({ ok: false, error: "Missing OAuth fields." }, 400);
        const expected = new URL("/callback", url.origin).href;
        if (redirect_uri !== expected) return json({ ok: false, error: "Redirect URL does not match this deployment." }, 400);

        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: env.DERIV_APP_ID,
          code,
          code_verifier,
          redirect_uri
        });

        const response = await fetch(`${DERIV_AUTH}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body
        });
        const result = await response.json();
        if (!response.ok) return json({ ok: false, error: result.error_description || result.error || "Deriv token exchange failed." }, response.status);
        return json({ ok: true, access_token: result.access_token, expires_in: result.expires_in });
      } catch {
        return json({ ok: false, error: "Could not complete OAuth token exchange." }, 500);
      }
    }

    if (url.pathname === "/api/accounts" && request.method === "GET") {
      return derivRequest(request, "/trading/v1/options/accounts");
    }

    if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/otp") && request.method === "POST") {
      const accountId = decodeURIComponent(url.pathname.slice("/api/accounts/".length, -"/otp".length));
      if (!accountId || accountId.includes("/")) return json({ ok: false, error: "Invalid account ID." }, 400);
      return derivRequest(request, `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, "POST");
    }

    return env.ASSETS.fetch(request);
  }
};

async function derivRequest(request, path, method = "GET") {
  const token = request.headers.get("authorization");
  if (!token || !token.startsWith("Bearer ")) return json({ ok: false, error: "Please connect your Deriv account first." }, 401);
  const response = await fetch(`${DERIV_API}${path}`, {
    method,
    headers: { authorization: token, "content-type": "application/json" }
  });
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
