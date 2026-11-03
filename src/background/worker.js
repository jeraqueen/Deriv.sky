import { DurableObject } from "cloudflare:workers";

const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const RECONNECT_MS = 5000;
const HEARTBEAT_MS = 60_000;

function lastDigit(tick) {
  if (!tick || tick.quote === undefined || !Number.isInteger(tick.pip_size) ||
      tick.pip_size < 0 || tick.pip_size > 10) return null;
  const quote = Number(tick.quote);
  if (!Number.isFinite(quote)) return null;
  const digits = quote.toFixed(tick.pip_size).replace(/\D/g, "");
  return digits.length ? Number(digits.at(-1)) : null;
}
function isVolatility(item) {
  // Deriv's active_symbols labels vary by market/version. Do not require
  // the word "Index" to be present; inspect all identifying fields.
  const identity = [item?.display_name, item?.name, item?.symbol]
    .filter(Boolean).join(" ");
  return /volatility/i.test(identity) ||
    /^(?:1HZ)?(?:10|15|25|30|50|75|90|100)V$/i.test(String(item?.symbol || "")) ||
    /^R_(?:10|25|50|75|100)$/i.test(String(item?.symbol || ""));
}

export class MarketEngine extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.socket = null;
    this.connecting = false;
    this.state = {
      running: false, enabled: true, status: "starting", markets: 0, ticks: 0,
      latestMarket: null, latestDigit: null, lastTickAt: null,
      connectedAt: null, lastError: null, lastMessageType: null,
      activeSymbolsReceived: false, rawSymbolCount: 0, matchedSymbolCount: 0,
      sampleSymbolNames: []
    };
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("state");
      if (saved) this.state = { ...this.state, ...saved };
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/ensure" && !this.state.enabled) {
      return Response.json({ ok: true, ...this.state });
    }
    if (url.pathname === "/start" || url.pathname === "/ensure") {
      await this.start();
      return Response.json({ ok: true, ...this.state });
    }
    if (url.pathname === "/stop") {
      await this.stop();
      return Response.json({ ok: true, ...this.state });
    }
    if (url.pathname === "/test") {
      const previousTicks = this.state.ticks;
      await this.start();
      await new Promise(resolve => setTimeout(resolve, 8000));
      const receivedNewTick = this.state.ticks > previousTicks;
      return Response.json({
        ok: receivedNewTick,
        test: "public-deriv-live-tick",
        receivedNewTick,
        ...this.state,
        note: receivedNewTick
          ? "Deriv returned live market ticks to the background service."
          : "No new tick arrived during the 8-second test window. Check feed status and retry."
      }, { status: receivedNewTick ? 200 : 503 });
    }
    if (url.pathname === "/status") {
      return Response.json({ ok: true, ...this.state, uptimeMode: "Cloudflare Durable Object background feed" });
    }
    return Response.json({ ok: false, error: "Use /start, /ensure, /status or /stop" }, { status: 404 });
  }

  async save() {
    await this.ctx.storage.put("state", this.state);
  }

  async start() {
    this.state.enabled = true;
    this.state.running = true;
    if (!this.socket && !this.connecting) this.connect();
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    await this.save();
  }

  async stop() {
    this.state.running = false;
    this.state.enabled = false;
    this.state.status = "stopped";
    if (this.socket) {
      try { this.socket.close(1000, "Scanner stopped"); } catch {}
      this.socket = null;
    }
    await this.ctx.storage.deleteAlarm();
    await this.save();
  }

  connect() {
    if (!this.state.running || this.connecting || this.socket) return;
    this.connecting = true;
    this.state.status = "connecting";
    let ws;
    try {
      ws = new WebSocket(DERIV_PUBLIC_WS);
    } catch (error) {
      this.connecting = false;
      this.failed(error);
      return;
    }
    this.socket = ws;
    ws.addEventListener("open", () => {
      this.connecting = false;
      if (!this.state.running) { ws.close(); return; }
      this.state.status = "connected";
      this.state.connectedAt = new Date().toISOString();
      this.state.lastError = null;
      ws.send(JSON.stringify({ active_symbols: "brief", req_id: 1 }));
      this.save();
    });
    ws.addEventListener("message", event => {
      this.onMessage(event.data).catch(error => this.failed(error));
    });
    ws.addEventListener("error", () => this.failed(new Error("Deriv WebSocket error")));
    ws.addEventListener("close", () => {
      if (this.socket === ws) this.socket = null;
      this.connecting = false;
      if (this.state.running) {
        this.state.status = "reconnecting";
        this.scheduleReconnect();
      }
      this.save();
    });
  }

  async onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    this.state.lastMessageType = msg.msg_type || "unknown";
    if (msg.error || msg.errors?.length) {
      this.state.lastError = msg.error?.message || msg.errors?.[0]?.message || "Deriv API error";
      this.state.status = "deriv-api-error";
      await this.save();
      return;
    }
    if (msg.msg_type === "active_symbols" || Array.isArray(msg.active_symbols) || Array.isArray(msg.data?.active_symbols)) {
      const allSymbols = msg.active_symbols || msg.data?.active_symbols || [];
      const markets = allSymbols.filter(isVolatility);
      this.state.activeSymbolsReceived = true;
      this.state.rawSymbolCount = allSymbols.length;
      this.state.matchedSymbolCount = markets.length;
      this.state.sampleSymbolNames = allSymbols.slice(0, 12).map(item =>
        String(item?.display_name || item?.name || item?.symbol || "unnamed")
      );
      this.state.markets = markets.length;
      this.state.status = markets.length ? "streaming" : "no-volatility-markets";
      if (this.socket?.readyState === WebSocket.OPEN) {
        for (const item of markets) {
          this.socket.send(JSON.stringify({ ticks: item.symbol, subscribe: 1 }));
        }
      }
      await this.save();
      return;
    }
    if (msg.msg_type === "tick" && msg.tick?.symbol) {
      const digit = lastDigit(msg.tick);
      if (digit === null) return;
      this.state.ticks += 1;
      this.state.latestMarket = msg.tick.symbol;
      this.state.latestDigit = digit;
      this.state.lastTickAt = new Date().toISOString();
      // Keep hot tick updates in memory; persist snapshots on the minute
      // heartbeat rather than writing to SQLite for every market tick.
    }
  }

  async failed(error) {
    this.state.lastError = String(error?.message || error);
    if (this.state.running) {
      this.state.status = "reconnecting";
      await this.scheduleReconnect();
    }
    await this.save();
  }

  async scheduleReconnect() {
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_MS);
  }

  async alarm() {
    await this.ready;
    if (!this.state.running) return;
    if (!this.socket && !this.connecting) this.connect();
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }
}

async function engine(env) {
  const id = env.MARKET_ENGINE.idFromName("sky-bot-volatility-scanner");
  return env.MARKET_ENGINE.get(id);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = await engine(env);
    const path = ["/start", "/stop", "/status", "/ensure"].includes(url.pathname) ? url.pathname : "/status";
    return stub.fetch("https://engine" + path);
  },
  async scheduled(_event, env, ctx) {
    const stub = await engine(env);
    ctx.waitUntil(stub.fetch("https://engine/ensure"));
  }
};
