// What the customer "test mode" banner says — built from the real state
// of each partner, so it never says something is not real when it is
// live. Sandbox = the partner is on test keys (test money). It only
// mentions features that are switched on (Send to Bank is added when it
// is on and its partner is on test keys) and never names banks.

async function state(settings) {
  const s = settings || (await require('./vtpass').getSettings());
  const modes = await require('./goLive').partnerModes().catch(() => ({ monnify: 'sandbox', squad: 'sandbox', nomba: 'sandbox' }));
  const on = {
    monnify: s.monnifyFundingEnabled !== false,
    squad: await require('./squad').fundingOn().catch(() => false),
    nomba: await require('./nomba').fundingOn().catch(() => false),
  };
  const payVia = ['squad', 'nomba'].includes(s.payoutProvider) ? s.payoutProvider : 'monnify';
  // Send to Bank only counts while it is switched on.
  const payoutsTest = Boolean(s.bankTransferEnabled) && modes[payVia] !== 'live';
  const purchasesLive = s.vtpassMode === 'live';
  const fundingTest = Object.keys(on).filter((k) => on[k] && modes[k] !== 'live');
  const fundingLive = Object.keys(on).filter((k) => on[k] && modes[k] === 'live');
  let text = null;
  if (!purchasesLive) {
    text = 'ZAPPI PAY is still being tested — purchases here are not real yet and no real money is charged or sent.';
  } else if ((fundingTest.length && !fundingLive.length) || payoutsTest) {
    // Once any funding partner customers use is live, real funding works,
    // so the funding warning goes away (only Send to Bank can keep it).
    // Funding on sandbox keys still takes small real transfers (Nomba), so it
    // says "small amounts only" rather than "test money".
    const fundingTesting = fundingTest.length && !fundingLive.length;
    const parts = ['Airtime, data and bills are live.'];
    if (fundingTesting) parts.push('Wallet funding is in testing: small amounts only for now.');
    if (payoutsTest) parts.push('Send to Bank uses test money for now, so please don’t send real money to a bank yet.');
    text = parts.join(' ');
  }
  return { testMode: Boolean(text), text, purchasesLive, fundingTest, fundingLive, payoutsTest, modes };
}

module.exports = { state };
