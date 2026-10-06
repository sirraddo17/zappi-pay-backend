// The Ajo Circle member agreement. Every member must read and accept it
// (with their transaction PIN) before they count as a member; they can
// re-read it at any time from the circle page. Bump VERSION when the
// wording changes — members of new circles accept the new version.
//
// Written in plain English on purpose. Have a Nigerian lawyer review it
// before switching Ajo Circle on for customers.

const VERSION = 1;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const PERIOD = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' };

function terms(circle, { appShare = 20 } = {}) {
  const c = circle;
  const per = PERIOD[c.frequency] || 'period';
  const pot = Number(c.amount) * Number(c.size);
  const fee = Number(c.payoutFee || 0);
  const pen = Number(c.penaltyFee || 0);
  const creatorShare = 100 - appShare;
  return [
    { h: '1. What this is', p: [
      `“${c.name}” is a rotating contribution group (ajo / esusu / adashe) of ${c.size} members, organised by its creator on ZAPPI PAY.`,
      `Every ${per}, each member contributes ${naira(c.amount)}. Each ${per}, one member — in the order of the payout numbers — receives the full pot of ${naira(pot)}${fee > 0 ? `, less the payout fee` : ''}.`,
      'This is members saving together. It is not a loan, an investment or a deposit: nobody earns interest, the money is not invested, and ZAPPI PAY does not promise any return. ZAPPI PAY provides the app that collects and pays out the contributions on the members’ instructions.',
    ] },
    { h: '2. Automatic payments (standing instruction)', p: [
      `I authorise ZAPPI PAY to take ${naira(c.amount)} from my ZAPPI PAY wallet on every payment day of this circle until the circle ends.`,
      'If my wallet does not have enough on the day, I authorise ZAPPI PAY to take what is there and the rest later: it tries again every hour and immediately whenever money comes into my wallet.',
      'I will be reminded before each payment day (3 days before for weekly and monthly circles, and again if my balance is low).',
    ] },
    { h: '3. The pot is held until everyone pays', p: [
      'Money collected for a payout is held in that payout’s pot. Every member can see it. Nobody — not members, not the creator, not ZAPPI PAY staff — can spend or withdraw it.',
      'A payout is only made when every member has paid for that period. If someone is late, the payout waits, and every member can see who is late and why.',
      'The member due to be paid may ask for the money already collected early. They must accept that the rest arrives when the late members pay, and a ZAPPI PAY admin must approve it.',
    ] },
    { h: '4. Late payment', p: [
      pen > 0 ? `If my payment is still not complete ${c.graceHours} hours after the payment day, a late fee of ${naira(pen)} is added to what I owe for that period. The late fee goes into the same pot, to the member being paid.` : `There is no late fee in this circle, but a payment not complete ${c.graceHours} hours after the payment day counts as a missed payment.`,
      `Each missed payment is a “strike”. If I have not received my payout yet and I get ${c.strikesToLast} strike${c.strikesToLast === 1 ? '' : 's'}, my payout number moves to the end of the list, automatically.`,
      'While I owe money to a circle after I have already received my payout, I cannot buy services, send money or withdraw from my ZAPPI PAY wallet until it is settled. Money that comes into my wallet goes to the circle first.',
      'Members with repeated missed payments are kept out of new circles. A ban can only be lifted by ZAPPI PAY after an appeal, and I must accept the agreement again.',
    ] },
    { h: '5. Fees', p: [
      fee > 0
        ? `A payout fee of ${naira(fee)} is taken from each payout. ${creatorShare}% goes to the circle’s creator and ${appShare}% to ZAPPI PAY for running the service.`
        : 'There is no payout fee in this circle — every member receives the full pot.',
      'The creator cannot add or change fees after the circle starts.',
    ] },
    { h: '6. Leaving and ending', p: [
      'I can leave before the circle starts. Once it starts I stay until every member has received their payout.',
      'If the circle has to be stopped, ZAPPI PAY returns money held in pots that have not been paid out to the members who paid it.',
    ] },
    { h: '7. Disputes and records', p: [
      'Every payment, payout, strike and change is recorded in the circle history, which all members can see.',
      'If I disagree with something, I will contact ZAPPI PAY support from the app first. Nothing in this agreement takes away any right I have under Nigerian law.',
    ] },
    ...(c.extraRules ? [{ h: '8. Extra rules from the creator', p: String(c.extraRules).split(/\n+/).map((x) => x.trim()).filter(Boolean) }] : []),
  ];
}

function text(circle, opts) {
  return terms(circle, opts).map((s) => `${s.h}\n${s.p.map((x) => `• ${x}`).join('\n')}`).join('\n\n');
}

module.exports = { VERSION, terms, text };
