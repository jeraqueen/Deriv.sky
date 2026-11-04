import { DurableObject } from "cloudflare:workers";
import { DiffersStrategy } from "./differs.js";
import { evaluateMatchesStrategy } from "./matches.js";
import { buildDigitHistogram, DIGIT_HISTORY_WINDOW } from "./digit-histogram.js";

const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const RECONNECT_MS = 5000;
const HEARTBEAT_MS = 15_000;
const STALE_TICK_MS = 30_000;

function lastDigit(tick) {
  if (!tick || tick.quote === undefined || !Number.isInteger(tick.pip_size) ||
      tick.pip_size < 0 || tick.pip_size > 10) return null;
  const quote = Number(tick.quote);
  if (!Number.isFinite(quote)) return null;
  const digits = quote.toFixed(tick.pip_size).replace(/\D/g, "");
  return digits.length ? Number(digits.at(-1)) : null;
}
const APPROVED_MARKET_ORDER = ["1HZ10V","1HZ15V","1HZ25V","1HZ30V","1HZ50V","1HZ75V","1HZ90V","1HZ100V","R_10","R_25","R_50","R_75","R_100"];
const APPROVED_VOLATILITY_SYMBOLS = new Set(APPROVED_MARKET_ORDER);
function symbolCode(item) {
  return String(item?.underlying_symbol || item?.symbol || "");
}
function isVolatility(item) {
  return APPROVED_VOLATILITY_SYMBOLS.has(symbolCode(item));
}

export class MarketEngine extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.socket = null;
    this.connecting = false;
    this.digitHistory = new Map();
    this.differStrategy = new DiffersStrategy();
    this.tickSequence = 0;
    this.marketDiagnostics = new Map();
    this.state = {
      running: false, enabled: true, status: "starting", markets: 0, ticks: 0,
      latestMarket: null, latestDigit: null, lastTickAt: null,
      connectedAt: null, lastError: null, lastMessageType: null,
      activeSymbolsReceived: false, rawSymbolCount: 0, matchedSymbolCount: 0,
      sampleSymbolNames: [], sampleSymbolKeys: [], sampleSymbolPreview: null,
      lastCloseCode: null, lastCloseReason: null,
      tickSubscriptionRequestedAt: null, tickSubscriptionRequestId: null,
      tickSubscriptionAckAt: null, tickSubscriptionCount: 0,
      strategyMode: "SIGNALS_FOR_AUTHENTICATED_DEMO_EXECUTION", strategyWindow: DIGIT_HISTORY_WINDOW,
      strategyReadyMarkets: 0, strategySignals: 0,
      strategyLastEvaluation: null, strategyLastSignal: null, strategyMarkets: [],
      strategyPendingSignals: [], marketScanMatches: [], marketScanUpdatedAt: null, strategyLastExecution: null,
      rotationIndex: 0, rotationRound: 1, rotationByMarket: {}
    };
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("state");
      if (saved) this.state = { ...this.state, ...saved };
      this.state.strategyMode = "SIGNALS_FOR_AUTHENTICATED_DEMO_EXECUTION";
      const strategySnapshot = await this.ctx.storage.get("strategyState");
      if (strategySnapshot) this.differStrategy.restore(strategySnapshot);
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/stream" || (url.pathname === "/api/scanner" && url.searchParams.get("action") === "stream")) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket upgrade required.", { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: "signal-client", connectedAt: Date.now() });
      server.send(JSON.stringify({ type: "ready", running: this.state.running, status: this.state.status, serverTime: new Date().toISOString() }));
      return new Response(null, { status: 101, webSocket: client });
    }
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
    if (url.pathname === "/ack" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "Invalid acknowledgement body." }, { status: 400 }); }
      const pending = this.state.strategyPendingSignals || [];
      const index = pending.findIndex(item => item.signalId === body.signalId);
      if (index < 0) {
        const previous = this.state.strategyLastExecution;
        if (body.accepted === true && previous?.signalId === body.signalId && previous.accepted === true) {
          return Response.json({ ok: true, accepted: true, duplicate: true, execution: previous });
        }
        return Response.json({ ok: false, error: "Signal is no longer pending or has expired." }, { status: 404 });
      }
      const signal = pending[index];
      if (body.market !== signal.market || Number(body.cycle) !== Number(signal.cycle)) return Response.json({ ok: false, error: "Signal acknowledgement did not match the pending signal." }, { status: 400 });
      let accepted = false;
      if (body.accepted === true) {
        if (!body.contractId) return Response.json({ ok: false, error: "Confirmed purchase acknowledgement requires a contract ID." }, { status: 400 });
        if (signal.strategy !== "MATCHES") {
          accepted = this.differStrategy.recordAcceptedTrade(signal.market, signal.cycle, body.contractId);
          if (!accepted) return Response.json({ ok: false, error: "DIFFER setup no longer accepts this trade." }, { status: 409 });
        } else accepted = true;
        const rotation = this.rotationStateFor(signal.market);
        rotation.pending = false;
        rotation.openContracts.push({ contractId:String(body.contractId), cycle:Number(signal.cycle), strategy:signal.strategy || "DIFFERS" });
      } else {
        if (signal.strategy !== "MATCHES") this.differStrategy.releasePending(signal.market, signal.cycle);
        this.rotationStateFor(signal.market).pending = false;
      }
      this.state.strategyPendingSignals = pending.filter(item => item.signalId !== signal.signalId);
      this.state.strategyLastExecution = { signalId: signal.signalId, market: signal.market, cycle: signal.cycle, accepted, detail: String(body.detail || "").slice(0, 240), timestamp: new Date().toISOString() };
      await this.save();
      return Response.json({ ok: true, accepted, pending: this.state.strategyPendingSignals.length, execution: this.state.strategyLastExecution });
    }
    if (url.pathname === "/result" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "Invalid contract result body." }, { status: 400 }); }
      const market = String(body.market || "");
      const cycle = Number(body.cycle);
      const contractId = String(body.contractId || "");
      if (!APPROVED_VOLATILITY_SYMBOLS.has(market) || !Number.isInteger(cycle) || !contractId || typeof body.won !== "boolean") {
        return Response.json({ ok: false, error: "Invalid market, cycle, contract ID, or result." }, { status: 400 });
      }
      const rotation = this.rotationStateFor(market);
      const openIndex = rotation.openContracts.findIndex(item => item.contractId === contractId);
      if (openIndex < 0) return Response.json({ ok: false, error: "Contract result was already reported or is unknown." }, { status: 404 });
      const [open] = rotation.openContracts.splice(openIndex, 1);
      if (open.strategy !== "MATCHES") {
        const differResult = this.differStrategy.recordContractResult(market, cycle, contractId, body.won);
        if (!differResult.ok) return Response.json({ ok:false, error:"DIFFER contract result was not recognised." }, {status:404});
      }
      if (body.won) rotation.consecutiveWins += 1;
      else rotation.consecutiveWins = 0;
      const completed = rotation.consecutiveWins >= 2;
      if (completed) {
        this.state.rotationIndex = (Number(this.state.rotationIndex || 0) + 1) % APPROVED_MARKET_ORDER.length;
        if (this.state.rotationIndex === 0) this.state.rotationRound = Number(this.state.rotationRound || 1) + 1;
        rotation.consecutiveWins = 0;
      }
      this.state.strategyLastExecution = { ...(this.state.strategyLastExecution || {}), market, cycle,
        contractId, strategy:open.strategy, result: body.won ? "WIN" : "LOSS",
        consecutiveWins: completed ? 2 : rotation.consecutiveWins, completed,
        nextMarket: this.activeRotationMarket(), timestamp: new Date().toISOString() };
      await this.save();
      return Response.json({ ok:true, wins:rotation.consecutiveWins, consecutiveWins:rotation.consecutiveWins,
        losses:rotation.losses || 0, completed, nextMarket:this.activeRotationMarket() });
    }
    if (url.pathname === "/markets") {
      const results = [];
      for (const [market, history] of this.digitHistory.entries()) {
        if (!/^R_(10|25|50|75|100)$/.test(market) || history.length < DIGIT_HISTORY_WINDOW) continue;
        const histogram = buildDigitHistogram(history);
        if (!histogram.ready || !histogram.counts) continue;
        const ranked = histogram.counts.map((count, digit) => ({ digit, count, percentage: count / DIGIT_HISTORY_WINDOW * 100 }))
          .sort((a,b) => b.count - a.count || a.digit - b.digit);
        const top = new Set([ranked[0].digit, ranked[1].digit]);
        const bottom = new Set([ranked[8].digit, ranked[9].digit]);
        const zero = ranked.find(item => item.digit === 0);
        const nine = ranked.find(item => item.digit === 9);
        const digitFour = ranked.find(item => item.digit === 4);
        const digitFive = ranked.find(item => item.digit === 5);
        const qualifies = zero.percentage < 10 && nine.percentage < 10 &&
          !top.has(4) && !bottom.has(4) && !top.has(5) && !bottom.has(5);
        results.push({ market, sampleSize:history.length, zeroPercentage:zero.percentage,
          ninePercentage:nine.percentage, digitFourPercentage:digitFour.percentage,
          digitFivePercentage:digitFive.percentage, green:ranked[0], blue:ranked[1],
          orange:ranked[8], red:ranked[9], qualifies });
      }
      results.sort((a,b) => Number(b.qualifies)-Number(a.qualifies) ||
        (a.zeroPercentage+a.ninePercentage)-(b.zeroPercentage+b.ninePercentage));
      return Response.json({ok:true, window:DIGIT_HISTORY_WINDOW, marketsScanned:results.length,
        qualifying:results.filter(item=>item.qualifies), results, note:"Standard Volatility indices only; 1-second indices excluded."});
    }
    if (url.pathname === "/status") {
      return Response.json({ ok: true, ...this.state, uptimeMode: "Cloudflare Durable Object background feed" });
    }
    return Response.json({ ok: false, error: "Use /start, /ensure, /status or /stop" }, { status: 404 });
  }

  rotationStateFor(market) {
    this.state.rotationByMarket ||= {};
    if (!this.state.rotationByMarket[market]) this.state.rotationByMarket[market] = { consecutiveWins:0, losses:0, pending:false, openContracts:[] };
    const item=this.state.rotationByMarket[market]; item.consecutiveWins ||= 0; item.openContracts ||= []; item.pending ||= false;
    return item;
  }

  activeRotationMarket() {
    return APPROVED_MARKET_ORDER[Number(this.state.rotationIndex || 0) % APPROVED_MARKET_ORDER.length];
  }

  async save() {
    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.put("strategyState", this.differStrategy.snapshot());
  }

  broadcastRealtime(event) {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(payload); }
      catch { try { ws.close(1011, "Signal stream send failed"); } catch {} }
    }
  }

  async webSocketMessage(ws, message) {
    if (message === "ping") { try { ws.send("pong"); } catch {} }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
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
    ws.addEventListener("close", event => {
      this.state.lastCloseCode = event.code;
      this.state.lastCloseReason = event.reason || "";
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
      this.state.status = "reconnecting";
      const failedSocket = this.socket;
      this.socket = null;
      this.connecting = false;
      if (failedSocket) {
        try { failedSocket.close(1011, "Deriv API error; reconnecting"); } catch {}
      }
      if (this.state.running) await this.scheduleReconnect();
      await this.save();
      return;
    }
    if (msg.msg_type === "active_symbols" || Array.isArray(msg.active_symbols) || Array.isArray(msg.data?.active_symbols)) {
      const allSymbols = msg.active_symbols || msg.data?.active_symbols || [];
      const markets = allSymbols.filter(isVolatility);
      this.state.activeSymbolsReceived = true;
      this.state.rawSymbolCount = allSymbols.length;
      this.state.matchedSymbolCount = markets.length;
      this.state.sampleSymbolKeys = allSymbols[0] && typeof allSymbols[0] === "object"
        ? Object.keys(allSymbols[0]).slice(0, 30) : [];
      this.state.sampleSymbolPreview = allSymbols[0] && typeof allSymbols[0] === "object"
        ? JSON.stringify(allSymbols[0]).slice(0, 1200) : String(allSymbols[0] ?? "empty");
      this.state.sampleSymbolNames = allSymbols.slice(0, 12).map(item =>
        String(item?.underlying_symbol_name || item?.display_name || item?.name || symbolCode(item) || "unnamed")
      );
      this.state.markets = markets.length;
      this.state.status = markets.length ? "subscribing" : "no-volatility-markets";
      this.state.tickSubscriptionCount = 0;
      if (this.socket?.readyState === WebSocket.OPEN && markets.length) {
        const symbols = markets.map(symbolCode).filter(Boolean);
        this.state.tickSubscriptionRequestedAt = new Date().toISOString();
        this.state.tickSubscriptionRequestId = 2;
        this.socket.send(JSON.stringify({
          ticks: symbols,
          subscribe: 1,
          req_id: this.state.tickSubscriptionRequestId
        }));
      }
      await this.save();
      return;
    }
    if (msg.msg_type === "tick" && (msg.tick?.symbol || msg.tick?.underlying_symbol)) {
      const now = Date.now();
      const pendingSignals = this.state.strategyPendingSignals || [];
      const expiredSignals = pendingSignals.filter(item => now - Date.parse(item.timestamp) > 10000);
      for (const item of expiredSignals) {
        if (item.strategy !== "MATCHES") this.differStrategy.releasePending(item.market, item.cycle);
        this.rotationStateFor(item.market).pending = false;
      }
      this.state.strategyPendingSignals = pendingSignals.filter(item => now - Date.parse(item.timestamp) <= 10000);
      let pendingQueueChanged = expiredSignals.length > 0;
      const realtimeEvents = expiredSignals.map(item => ({
        type: "signal_invalidated", signalId: item.signalId, market: item.market,
        reason: "Signal expired before execution."
      }));
      const digit = lastDigit(msg.tick);
      if (digit === null) return;
      const market = msg.tick.symbol || msg.tick.underlying_symbol;
      this.state.ticks += 1;
      this.state.status = "streaming";
      this.state.tickSubscriptionAckAt ||= new Date().toISOString();
      this.state.tickSubscriptionCount += 1;
      this.state.latestMarket = market;
      this.state.latestDigit = digit;
      this.state.lastTickAt = new Date().toISOString();

      // Keep a rolling 100-tick digit window independently for each market.
      const history = this.digitHistory.get(market) || [];
      history.push(digit);
      if (history.length > DIGIT_HISTORY_WINDOW) history.shift();
      this.digitHistory.set(market, history);

      // Scan standard Volatility markets (R_*) independently of the 1-second markets.
      // Conditions: digit 0 and 9 each below 10%; digits 4 and 5 have no colour marker.
      if (market.startsWith("R_") && history.length >= DIGIT_HISTORY_WINDOW) {
        const scanHistogram = buildDigitHistogram(history);
        if (scanHistogram.counts?.length === 10) {
          const barsByDigit = new Map(scanHistogram.bars.map(bar => [bar.digit, bar]));
          const qualifies = scanHistogram.counts[0] < 10 && scanHistogram.counts[9] < 10 &&
            (barsByDigit.get(4)?.color || "neutral") === "neutral" &&
            (barsByDigit.get(5)?.color || "neutral") === "neutral";
          const matches = (this.state.marketScanMatches || []).filter(item => item.market !== market);
          if (qualifies) matches.push({
            market, digit0Percentage: scanHistogram.counts[0], digit9Percentage: scanHistogram.counts[9],
            updatedAt: new Date().toISOString()
          });
          this.state.marketScanMatches = matches.sort((a,b) => a.market.localeCompare(b.market));
          this.state.marketScanUpdatedAt = new Date().toISOString();
        }
      }

      // Build history for every market, but only evaluate/enter on the current
      // rotation market. Two consecutive wins move the board to the next market.
      if (market !== this.activeRotationMarket()) { if (pendingQueueChanged) await this.save(); return; }
      const rotation = this.rotationStateFor(market);
      if (rotation.pending || rotation.openContracts.length) { if (pendingQueueChanged) await this.save(); return; }

      if (history.length >= DIGIT_HISTORY_WINDOW) {
        const histogram = buildDigitHistogram(history);
        const tickId = ++this.tickSequence;
        const evaluation = this.differStrategy.observe({ market, bars: histogram.bars, currentDigit: digit, tickId });
        const matchesEvaluation = evaluateMatchesStrategy({ counts:histogram.counts, currentDigit:digit, tickId });
        if (evaluation.action !== "PENDING") {
          const removedSignals = this.state.strategyPendingSignals.filter(item => item.market === market);
          this.state.strategyPendingSignals = this.state.strategyPendingSignals.filter(item => item.market !== market);
          if (removedSignals.length) {
            this.rotationStateFor(market).pending = false;
            pendingQueueChanged = true;
            for (const item of removedSignals) realtimeEvents.push({
              type: "signal_invalidated", signalId: item.signalId, market,
              reason: evaluation.reason || "The market setup changed before execution."
            });
          }
        }
        let diagnostic = {
          market,
          sampleSize: history.length,
          counts: histogram.counts,
          bars: histogram.bars,
          histogramValid: histogram.valid,
          histogramReason: histogram.reason,
          greenDigit: histogram.greenDigit ?? null,
          greenPercentage: histogram.greenPercentage ?? null,
          redDigit: histogram.redDigit ?? null,
          redPercentage: histogram.redPercentage ?? null,
          digitSeparation: histogram.valid
            ? Math.abs(histogram.greenDigit - histogram.redDigit) : null,
          action: evaluation.action,
          reason: evaluation.reason || histogram.reason,
          cycle: evaluation.cycle ?? null,
          simulatedTradesThisCycle: this.differStrategy.stateFor(market).trades,
          winsThisCycle: this.differStrategy.stateFor(market).wins,
          openContracts: this.differStrategy.stateFor(market).openContracts.length
        };

        const chosen = evaluation.action === "BUY_INTENT"
          ? { ...evaluation, strategy:"DIFFERS", cycle:evaluation.cycle }
          : matchesEvaluation.action === "BUY_INTENT"
            ? { ...matchesEvaluation, strategy:"MATCHES", cycle:Number(this.state.rotationRound || 1) }
            : null;
        if (chosen) {
          const timestamp = new Date().toISOString();
          const signalId = market + ":" + chosen.strategy + ":" + chosen.cycle + ":" + tickId;
          const signal = { signalId, strategy:chosen.strategy, market, barrier:chosen.barrier, contractType:chosen.contractType, duration:chosen.duration, durationUnit:chosen.durationUnit, cycle:chosen.cycle, timestamp, orderPlaced: false };
          this.state.strategySignals += 1;
          this.state.strategyPendingSignals.push(signal);
          this.state.strategyPendingSignals = this.state.strategyPendingSignals.slice(-13);
          rotation.pending = true;
          pendingQueueChanged = true;
          diagnostic.action = "PENDING_DEMO_SIGNAL";
          diagnostic.reason = "Valid " + chosen.strategy + " trigger queued for authenticated demo execution.";
          diagnostic.barrier = evaluation.barrier;
          diagnostic.strategy = chosen.strategy;
          diagnostic.contractType = chosen.contractType;
          diagnostic.duration = chosen.duration;
          diagnostic.durationUnit = chosen.durationUnit;
          diagnostic.signalId = signalId;
          diagnostic.simulatedTradesThisCycle = this.differStrategy.stateFor(market).trades;
          this.state.strategyLastSignal = signal;
          realtimeEvents.push({ type: "signal", signal });
        }

        this.marketDiagnostics.set(market, diagnostic);
        this.state.strategyReadyMarkets = this.marketDiagnostics.size;
        this.state.strategyMarkets = Array.from(this.marketDiagnostics.values());
        this.state.strategyLastEvaluation = diagnostic;
        if (pendingQueueChanged) await this.save();
        for (const event of realtimeEvents) this.broadcastRealtime(event);
      }
      // Tick processing stays in memory; authenticated demo execution is handled by the connected browser.
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
    const lastTickMs = this.state.lastTickAt ? Date.parse(this.state.lastTickAt) : 0;
    const referenceMs = lastTickMs || (this.state.connectedAt ? Date.parse(this.state.connectedAt) : 0);
    const stale = referenceMs > 0 && Date.now() - referenceMs > STALE_TICK_MS;
    if (stale && this.socket) {
      this.state.status = "reconnecting";
      this.state.lastError = "No market tick received for 30 seconds; reconnecting feed.";
      const staleSocket = this.socket;
      this.socket = null;
      this.connecting = false;
      try { staleSocket.close(1011, "Stale tick feed"); } catch {}
      await this.save();
      this.scheduleReconnect();
    } else if (!this.socket && !this.connecting) {
      this.connect();
    }
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
    const path = ["/start", "/stop", "/status", "/ensure", "/test", "/ack", "/result", "/stream"].includes(url.pathname) ? url.pathname : "/status";
    if (path === "/stream") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket upgrade required.", { status: 426 });
      return stub.fetch(request);
    }
    return stub.fetch("https://engine" + path);
  },
  async scheduled(_event, env, ctx) {
    const stub = await engine(env);
    ctx.waitUntil(stub.fetch("https://engine/ensure"));
  }
};
