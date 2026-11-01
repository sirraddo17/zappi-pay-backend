// What the customer "test mode" banner says — built from the real state
// of each partner, so it never says something is not real when it is
// live. Sandbox = the partner is on test keys (test money).

const NAMES = { monnify: 'Wema/Moniepoint', squad: 'GTBank', nomba: 'Nombank' };

async function state(settings) {
  const s = settings || (await require('./vtpass').getSettings());
  const modes = await require('./goLive').partnerModes().catch(() => ({ monnify: 'sandbox', squad: 'sandbox', nomba: 'sandbox' }));
  const on = {
    monnify: s.monnifyFundingEnabled !== false,
    squad: await require('./squad').fundingOn().catch(() => false),
    nomba: await require('./nomba').fundingOn().catch(() => false),
  };
  const payVia = ['squad', 'nomba'].includes(s.payoutProvider) ? s.payoutProvider : 'monnify';
  const purchasesLive = s.vtpassMode === 'live';
  const fundingTest = Object.keys(on).filter((k) => on[k] && modes[k] !== 'live');
  const fundingLive = Object.keys(on).filter((k) => on[k] && modes[k] === 'live');
  const payoutsTest = modes[payVia] !== 'live';
  let text = null;
  if (!purchasesLive) {
    text = 'ZAPPI PAY is still being tested — purchases here are not real yet and no real money is charged or sent.';
  } else if (fundingTest.length || payoutsTest) {
    const parts = [];
    if (fundingTest.length) parts.push(`wallet funding through ${fundingTest.map((k) => NAMES[k]).join(', ')} account numbers`);
    if (payoutsTest) parts.push('Send to Bank');
    text = `Airtime, data and bills are live. ${parts.join(' and ').replace(/^./, (c) => c.toUpperCase())} ${parts.length > 1 ? 'use' : 'uses'} test money for now — please don’t send real money there yet.${fundingLive.length ? ` ${fundingLive.map((k) => NAMES[k]).join(', ')} account numbers are live.` : ''}`;
  }
  return { testMode: Boolean(text), text, purchasesLive, fundingTest, fundingLive, payoutsTest, modes };
}

module.exports = { state, NAMES };
