// The account name a customer's BANK APP shows when someone sends money to
// their ZAPPI PAY account number (the app itself shows "ZAPPI PAY /
// Customer Name"). Each partner formats it differently:
//  • Monnify (live): "<business short name>-<first letters of the customer
//    name Monnify returns>", e.g. "SIRRADDO GLOBAL-RID". Monnify only
//    returns the short part ("RID"), so the business part is added here.
//  • Nomba: our company name, SIRRADDO GLOBAL LIMITED, until Nomba turns on
//    custom names ("ZAPPI PAY/Customer Name") for us.
//  • Squad and anything else: the name the partner returned.
const COMPANY = 'SIRRADDO GLOBAL LIMITED';
const MONNIFY_PREFIX = 'SIRRADDO GLOBAL';

function bankShowsName(a = {}) {
  const provider = String(a.provider || 'monnify').toLowerCase();
  const name = String(a.accountName || '').trim();
  if (provider === 'nomba') return COMPANY;
  if (provider === 'monnify') {
    if (!name) return MONNIFY_PREFIX;
    return /sirraddo/i.test(name) ? name : `${MONNIFY_PREFIX}-${name}`;
  }
  return name || null;
}

module.exports = { bankShowsName, COMPANY, MONNIFY_PREFIX };
