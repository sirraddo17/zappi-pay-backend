// VTpass response codes (from vtpass.com/documentation/response-codes)
// with a plain meaning, who caused it and what to do. Used for the
// admin "VTpass: …" reason, customer error text, recovery notices and
// owner alerts.
//
// who: customer — the customer's input (amount, quantity, account, repeat)
//      account  — our VTpass account/setup; only the owner can fix it
//      provider — VTpass or the biller is having a problem
//      app      — a bug in our request (should not happen)
//      ok       — not a failure

const CODES = {
  '000': ['TRANSACTION PROCESSED', 'ok', 'Accepted. The status field says if it is delivered, pending or initiated.', ''],
  '099': ['TRANSACTION IS PROCESSING', 'ok', 'Still processing — the app re-checks it automatically.', ''],
  '001': ['TRANSACTION QUERY', 'ok', 'Status check result.', ''],
  '044': ['TRANSACTION RESOLVED', 'provider', 'VTpass resolved this transaction manually.', 'Contact VTpass support for details.'],
  '091': ['TRANSACTION NOT PROCESSED', 'provider', 'VTpass did not process it and did not charge you.', 'Usually temporary — try again later.'],
  '016': ['TRANSACTION FAILED', 'provider', 'The biller or network failed it.', 'Usually temporary. If it keeps happening for one service, ask VTpass support.'],
  '010': ['VARIATION CODE DOES NOT EXIST', 'app', 'The plan/bundle code no longer exists at VTpass.', 'The plan may have been removed — refresh plans or tell support.'],
  '011': ['INVALID ARGUMENTS', 'app', 'A required field was missing in the request.', 'Report it — it is a bug in the request.'],
  '012': ['PRODUCT DOES NOT EXIST', 'app', 'That service ID does not exist at VTpass.', 'The service may have been renamed — check it with VTpass.'],
  '013': ['BELOW MINIMUM AMOUNT ALLOWED', 'customer', 'The amount is below this product’s minimum.', 'Use a bigger amount. For electricity, raise “Minimum electricity purchase” in Settings → Limits.'],
  '014': ['REQUEST ID ALREADY EXIST', 'app', 'This request ID was used before.', 'Report it — request IDs should be unique.'],
  '015': ['INVALID REQUEST ID', 'app', 'Status check for a request ID VTpass never received.', 'Nothing reached VTpass — no charge.'],
  '017': ['ABOVE MAXIMUM AMOUNT ALLOWED', 'customer', 'The amount is above this product’s maximum.', 'Use a smaller amount or split it.'],
  '018': ['LOW WALLET BALANCE', 'account', 'Your VTpass wallet does not have enough money.', 'Fund your VTpass wallet now — every purchase fails until you do.'],
  '019': ['LIKELY DUPLICATE TRANSACTION', 'customer', 'Same service for the same number within 30 seconds.', 'Wait 30 seconds before buying the same thing again.'],
  '021': ['ACCOUNT LOCKED', 'account', 'Your VTpass account is locked.', 'Contact VTpass support.'],
  '022': ['ACCOUNT SUSPENDED', 'account', 'Your VTpass account is suspended.', 'Contact VTpass support.'],
  '023': ['API ACCESS NOT ENABLE FOR USER', 'account', 'API access is not switched on for your VTpass account.', 'Ask VTpass support to activate API access.'],
  '024': ['ACCOUNT INACTIVE', 'account', 'Your VTpass account is inactive.', 'Contact VTpass support to activate it.'],
  '025': ['RECIPIENT BANK INVALID', 'customer', 'The bank code is invalid.', 'Pick the bank again.'],
  '026': ['RECIPIENT ACCOUNT COULD NOT BE VERIFIED', 'customer', 'The bank account could not be verified.', 'Check the account number.'],
  '027': ['IP NOT WHITELISTED, CONTACT SUPPORT', 'account', 'VTpass does not recognise the server’s IP address.', 'Send your server’s outbound IP addresses (Render → your service → Connect → Outbound) to VTpass support to whitelist.'],
  '028': ['PRODUCT IS NOT WHITELISTED ON YOUR ACCOUNT', 'account', 'This product is not enabled on your VTpass account.', 'Ask VTpass support to enable this product for your account.'],
  '030': ['BILLER NOT REACHABLE AT THIS POINT', 'provider', 'The biller (e.g. the electricity company) is down.', 'Temporary — customers are told automatically when it works again.'],
  '031': ['BELOW MINIMUM QUANTITY ALLOWED', 'customer', 'Quantity is below the minimum per purchase.', 'Buy more at once.'],
  '032': ['ABOVE MINIMUM QUANTITY ALLOWED', 'customer', 'Quantity is above the maximum per purchase.', 'Buy fewer at once.'],
  '034': ['SERVICE SUSPENDED', 'provider', 'VTpass has suspended this service for now.', 'Temporary — wait or ask VTpass when it is back.'],
  '035': ['SERVICE INACTIVE', 'provider', 'VTpass has switched this service off.', 'Pause it in the app until VTpass turns it on again.'],
  '040': ['TRANSACTION REVERSAL', 'provider', 'VTpass reversed it back to your VTpass wallet.', 'The customer is refunded.'],
  '083': ['SYSTEM ERROR', 'provider', 'VTpass had a system error.', 'Temporary — contact VTpass tech support if it continues.'],
  '085': ['IMPROPER REQUEST ID', 'app', 'The request ID did not start with today’s date.', 'Report it — usually the server clock.'],
  '087': ['INVALID CREDENTIALS', 'account', 'The VTpass API key / secret key is wrong for this mode.', 'Check the live (or sandbox) keys in Settings — they must match the mode.'],
  '089': ['REQUEST IS PROCESSING', 'provider', 'A previous request is still processing.', 'Wait a moment and try again.'],
  '020': ['BILLER CONFIRMED', 'ok', 'Meter / smartcard check passed.', ''],
};

const CUSTOMER_TEXT = {
  '013': 'The amount is below the minimum for this service — try a bigger amount.',
  '017': 'The amount is above the maximum for this service — try a smaller amount.',
  '019': 'You just bought this for the same number — please wait 30 seconds before trying again.',
  '031': 'That quantity is below the minimum — buy a few more at once.',
  '032': 'That quantity is above the maximum — buy fewer at once.',
};

function codeOf(payload) {
  const c = payload?.code;
  if (c === undefined || c === null || c === '') return '';
  return String(c).padStart(3, '0');
}

function describe(payloadOrCode) {
  const code = typeof payloadOrCode === 'object' && payloadOrCode ? codeOf(payloadOrCode) : String(payloadOrCode || '').replace(/\D/g, '').padStart(3, '0');
  const row = CODES[code];
  if (!row) return code ? { code, text: '', who: 'provider', meaning: 'Unknown VTpass code.', fix: 'Ask VTpass support what it means.' } : null;
  return { code, text: row[0], who: row[1], meaning: row[2], fix: row[3] };
}

// Extra sentence for the customer's "not successful" message.
function customerText(payload) {
  const d = describe(payload);
  if (!d) return '';
  if (CUSTOMER_TEXT[d.code]) return ` ${CUSTOMER_TEXT[d.code]}`;
  if (d.who === 'account' || d.who === 'provider' || d.who === 'app') return ' This was a problem on our side or the provider’s, not yours — we’ll let you know when it’s working again.';
  return '';
}

const list = () => Object.entries(CODES).map(([code, [text, who, meaning, fix]]) => ({ code, text, who, meaning, fix }));

// Owner alert for account problems (one per code per hour).
const lastAlert = new Map();
function alertIfAccount(payload, where = '') {
  const d = describe(payload);
  if (!d || d.who !== 'account') return false;
  const now = Date.now();
  if (now - (lastAlert.get(d.code) || 0) < 60 * 60 * 1000) return false;
  lastAlert.set(d.code, now);
  Promise.resolve(require('./adminAlert').alertAdmins(`VTpass ${d.code}: ${d.text}`, `${d.meaning} ${d.fix}${where ? ` (${where})` : ''} Purchases fail and are refunded until this is fixed.`, '/admin/orders')).catch(() => {});
  return true;
}

module.exports = { CODES, describe, customerText, codeOf, list, alertIfAccount, _reset: () => lastAlert.clear() };
