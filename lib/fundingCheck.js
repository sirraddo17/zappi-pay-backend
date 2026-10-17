// Support's "Funding not showing?" check: asks every payment partner the
// customer has an account number with (Monnify, Squad, Nomba) and credits
// only payments that partner confirms — never twice (each credit is keyed
// by the partner's own reference). Safe for support staff.

const NAMES = { monnify: 'Monnify', squad: 'Squad (GTBank)', nomba: 'Nomba (Nombank)' };

async function checkAll(customer, reference = '') {
  const monnify = require('./monnify');
  const squad = require('./squad');
  const nomba = require('./nomba');
  const ref = String(reference || '').trim();
  const out = { credited: 0, amount: 0, checked: [], failed: [], notes: [], refFound: false };
  const add = (r) => { if (r?.credited) { out.credited += r.credited === true ? 1 : r.credited; out.amount += Number(r.amount) || 0; } };

  const partners = [];
  if (customer.bankAccountRef && (await monnify.isConfigured().catch(() => false))) partners.push('monnify');
  if (customer.squadAccountRef && (await squad.isConfigured().catch(() => false))) partners.push('squad');
  if (customer.nombaAccountRef && (await nomba.isConfigured().catch(() => false))) partners.push('nomba');

  for (const p of partners) {
    try {
      // A reference the customer gave: look it up directly first.
      if (ref && !out.refFound) {
        let r = null;
        if (p === 'monnify') r = await monnify.creditFromTransaction(ref).catch(() => null);
        if (p === 'squad') {
          const t = await squad.findCustomerTransaction(customer.squadAccountRef, ref).catch(() => null);
          if (t) r = await squad.creditPayment({ customer_identifier: customer.squadAccountRef, ...t }, { source: 'api' });
        }
        if (r && (r.credited || r.reason === 'already credited')) {
          out.refFound = true;
          if (r.credited && r.customerId && r.customerId !== customer.id) out.notes.push('That reference belonged to a different customer’s account and was credited to them.');
          else if (r.credited) add(r);
          else out.notes.push(`That reference was already credited earlier (${NAMES[p]}) — check their wallet history.`);
        }
      }
      if (p === 'monnify') add(await monnify.syncCustomerPayments(customer));
      if (p === 'squad') add(await squad.syncCustomerPayments(customer));
      if (p === 'nomba') add(await nomba.syncCustomerPayments(customer));
      out.checked.push(NAMES[p]);
    } catch (error) {
      console.error(`fundingCheck ${p}:`, error.message);
      out.failed.push(NAMES[p]);
    }
  }
  out.amount = Math.round(out.amount * 100) / 100;
  out.hasAccounts = partners.length > 0 || Boolean(customer.bankAccountRef || customer.squadAccountRef || customer.nombaAccountRef);
  return out;
}

module.exports = { checkAll, NAMES };
