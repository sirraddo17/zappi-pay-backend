// PINs, tokens and exam cards are the product itself. Two rules keep a
// customer from getting both the PIN and a refund:
//  1. A VTpass reply that already carries PINs/tokens counts as delivered.
//  2. A customer never sees PINs/tokens unless the order is SUCCESS, and an
//     order that already received PINs is never refunded automatically.

const SECRET_KEYS = /^(purchased_code|mainToken|token|Token|tokens|cards|Pin|pin|Serial|serial|pins|bonusToken)$/;

const filled = (v) => (Array.isArray(v) ? v.some(filled) : v && typeof v === 'object' ? Object.values(v).some(filled) : String(v ?? '').replace(/^Token\s*:\s*/i, '').trim().length > 0);

// Does this VTpass reply contain a PIN, token or card?
function hasDeliverable(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const t = payload.content?.transactions || {};
  const spots = [payload.purchased_code, payload.mainToken, payload.token, payload.Token, payload.tokens, payload.cards, payload.content?.cards, t.purchased_code, t.cards, t.token];
  return spots.some((v) => (Array.isArray(v) ? v.some((c) => (typeof c === 'string' ? c.trim() : c && (c.Pin || c.pin || c.token))) : filled(v)));
}

// Copy of a payload with every PIN/token field removed.
function redact(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 6) return payload;
  if (Array.isArray(payload)) return payload.map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (SECRET_KEYS.test(k)) continue;
    out[k] = redact(v, depth + 1);
  }
  return out;
}

// What a customer may see of an order: PINs only once it is SUCCESS.
function customerView(order) {
  if (!order || order.status === 'SUCCESS' || !order.responsePayload) return order;
  return { ...order, responsePayload: redact(order.responsePayload) };
}

module.exports = { hasDeliverable, redact, customerView };
