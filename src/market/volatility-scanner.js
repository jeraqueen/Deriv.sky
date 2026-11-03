/**
 * Public Deriv market-data scanner.
 * Streams every currently active market whose display name identifies it
 * as a Volatility Index. This module does not place trades or infer the
 * platform's red/green last-digit histogram colors.
 */
export const PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

export const APPROVED_VOLATILITY_SYMBOLS = new Set(["1HZ10V","1HZ15V","1HZ25V","1HZ30V","1HZ50V","1HZ75V","1HZ90V","1HZ100V","R_10","R_25","R_50","R_75","R_100"]);

export function marketSymbol(item) {
  return String(item?.underlying_symbol || item?.symbol || "");
}

export function isVolatilityIndex(item) {
  return APPROVED_VOLATILITY_SYMBOLS.has(marketSymbol(item));
}

export function lastDigitFromTick(tick) {
  if (!tick || tick.quote === undefined || !Number.isInteger(tick.pip_size) ||
      tick.pip_size < 0 || tick.pip_size > 10) return null;
  const quote = Number(tick.quote);
  if (!Number.isFinite(quote)) return null;
  const formatted = quote.toFixed(tick.pip_size);
  const digits = formatted.replace(/\D/g, "");
  const last = digits.at(-1);
  return last === undefined ? null : Number(last);
}

/**
 * @param {{onSymbols?:Function,onTick?:Function,onStatus?:Function}} handlers
 * @returns {{close:Function, socket:WebSocket}}
 */
export function connectVolatilityScanner(handlers = {}) {
  const socket = new WebSocket(PUBLIC_WS_URL);
  const recentDigits = new Map();
  let symbols = [];

  socket.addEventListener("open", () => {
    handlers.onStatus?.("connected");
    socket.send(JSON.stringify({ active_symbols: "brief", req_id: 1 }));
  });

  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.error) {
      handlers.onStatus?.("error: " + (message.error.message || "Deriv API error"));
      return;
    }

    if (message.msg_type === "active_symbols") {
      symbols = (message.active_symbols || []).filter(isVolatilityIndex);
      handlers.onSymbols?.(symbols);
      if (!symbols.length) {
        handlers.onStatus?.("no-volatility-indices");
        return;
      }
      // Keep each request comfortably below the API's per-request limits.
      for (let i = 0; i < symbols.length; i += 50) {
        const batch = symbols.slice(i, i + 50).map(marketSymbol).filter(Boolean);
        socket.send(JSON.stringify({ ticks: batch, subscribe: 1, req_id: 100 + i }));
      }
      handlers.onStatus?.("streaming");
      return;
    }

    if (message.msg_type === "tick" && (message.tick?.symbol || message.tick?.underlying_symbol)) {
      const digit = lastDigitFromTick(message.tick);
      if (digit === null) return;
      const symbol = message.tick.symbol || message.tick.underlying_symbol;
      const history = recentDigits.get(symbol) || [];
      history.push(digit);
      if (history.length > 100) history.shift();
      recentDigits.set(symbol, history);
      handlers.onTick?.({
        symbol,
        quote: message.tick.quote,
        epoch: message.tick.epoch,
        currentDigit: digit,
        recentDigits: history.slice()
      });
    }
  });

  socket.addEventListener("close", () => handlers.onStatus?.("disconnected"));
  socket.addEventListener("error", () => handlers.onStatus?.("socket-error"));

  return {
    socket,
    close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  };
}
