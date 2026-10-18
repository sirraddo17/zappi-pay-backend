// The owner's own accounts with each partner: which account to FUND
// (top up a partner wallet so it can deliver bills / send transfers) and
// which account a partner PAYS money INTO (settlement). Shown in each
// partner's Settings section and all together in Payment partners →
// Overview. Account numbers aren't secrets, but only the owner can
// change them (and never the AI assistant).

const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');

const PARTNERS = {
  vtpass: 'VTpass',
  monnify: 'Monnify',
  squad: 'Squad (GTBank)',
  nomba: 'Nomba',
  flutterwave: 'Flutterwave',
  clubkonnect: 'ClubKonnect',
  other: 'Other',
};
const ROLES = { TOPUP: 'Fund (top-up)', SETTLEMENT: 'Receiving (settlement)', BOTH: 'Fund & receiving' };

// What the account is for, in plain words.
const WHAT = {
  vtpass: { TOPUP: 'Send money here to top up your VTpass wallet — it pays for every airtime, data, bill and PIN customers buy.', SETTLEMENT: 'VTpass pays refunds or withdrawals from your VTpass wallet into this account.' },
  monnify: { TOPUP: 'Send money here to top up your Monnify wallet — Send to Bank transfers are paid from it.', SETTLEMENT: 'Monnify pays the money customers send to their Wema / Sterling numbers (minus fees) into this account.' },
  squad: { TOPUP: 'Send money here to top up your Squad wallet — Send to Bank through Squad is paid from it.', SETTLEMENT: 'Squad pays the money customers send to their GTBank numbers into this account.' },
  nomba: { TOPUP: 'Send money here to top up your Nomba wallet — transfers and bet funding through Nomba are paid from it.', SETTLEMENT: 'Money customers send to their Nombank numbers lands in this account.' },
  flutterwave: { TOPUP: 'Send money here to top up your Flutterwave balance.', SETTLEMENT: 'Flutterwave pays customers’ card and USSD payments (minus fees) into this account.' },
  clubkonnect: { TOPUP: 'Send money here to top up your ClubKonnect wallet — it pays for recharge cards (and bet funding when ClubKonnect is the supplier).', SETTLEMENT: 'ClubKonnect pays withdrawals from your ClubKonnect wallet into this account.' },
  other: { TOPUP: 'An account you fund for this partner.', SETTLEMENT: 'An account this partner pays money into.' },
};
function whatItDoes(partner, role) {
  const w = WHAT[partner] || WHAT.other;
  if (role === 'BOTH') return `${w.SETTLEMENT} It is also the account you fund: ${w.TOPUP.charAt(0).toLowerCase()}${w.TOPUP.slice(1)}`;
  return w[role] || '';
}

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

class PartnerAccountError extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

function validate(list) {
  if (!Array.isArray(list)) throw new PartnerAccountError('Send a list of accounts.');
  if (list.length > 40) throw new PartnerAccountError('That is too many accounts (40 at most).');
  return list.map((a, i) => {
    const partner = PARTNERS[a?.partner] ? a.partner : null;
    const role = ROLES[a?.role] ? a.role : null;
    const accountNumber = String(a?.accountNumber || '').replace(/\D/g, '');
    if (!partner) throw new PartnerAccountError(`Account ${i + 1}: choose the partner.`);
    if (!role) throw new PartnerAccountError(`Account ${i + 1}: choose what it is for.`);
    if (!/^\d{10}$/.test(accountNumber)) throw new PartnerAccountError(`Account ${i + 1}: the account number must be 10 digits.`);
    const bankName = clean(a.bankName, 60);
    if (!bankName) throw new PartnerAccountError(`Account ${i + 1}: enter the bank name.`);
    return {
      id: /^[a-z0-9]{6,16}$/.test(String(a.id || '')) ? a.id : Math.random().toString(36).slice(2, 12),
      partner,
      role,
      bankName,
      accountNumber,
      accountName: clean(a.accountName, 80),
      note: clean(a.note, 160),
    };
  });
}

// Saved accounts, plus the ones already set elsewhere in Settings (shown
// read-only so nothing is entered twice).
async function list() {
  const s = await getSettings();
  const saved = (Array.isArray(s.partnerAccounts) ? s.partnerAccounts : []).map((a) => ({ ...a, source: 'saved' }));
  const auto = [];
  const wallet = String(s.monnifyWalletAccount || '').replace(/\D/g, '');
  if (wallet) auto.push({ id: 'auto-monnify-wallet', partner: 'monnify', role: 'TOPUP', bankName: 'Monnify wallet', accountNumber: wallet, accountName: '', note: 'Your Monnify payout wallet (set under Monnify → Send to Bank).', source: 'settings' });
  const benef = String(s.squadBeneficiaryAccount || '').replace(/\D/g, '');
  if (benef) auto.push({ id: 'auto-squad-beneficiary', partner: 'squad', role: 'SETTLEMENT', bankName: 'GTBank', accountNumber: benef, accountName: '', note: 'Squad settlement (beneficiary) account (set under Squad).', source: 'settings' });
  const all = [...auto.filter((x) => !saved.some((y) => y.accountNumber === x.accountNumber && y.partner === x.partner)), ...saved];
  return {
    partners: PARTNERS,
    roles: ROLES,
    accounts: all.map((a) => ({ ...a, partnerName: PARTNERS[a.partner] || a.partner, roleName: ROLES[a.role] || a.role, whatItDoes: whatItDoes(a.partner, a.role) })),
  };
}

async function save(input) {
  const accounts = validate(input);
  const s = await getSettings();
  await prisma.settings.update({ where: { id: s.id }, data: { partnerAccounts: accounts } });
  invalidateSettings();
  return list();
}

module.exports = { list, save, validate, whatItDoes, PARTNERS, ROLES, PartnerAccountError };
