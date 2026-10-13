// How customers send (transfer / "share") airtime on each network, for
// Airtime to Cash. Networks change these now and then — update here.
// {to} = receiving number, {amount} = naira amount, {pin} = their
// transfer PIN (never sent to us; they type it in their own dialer).
// Last checked: Oct 2026 (network guides + Nigerian USSD round-ups).
const CODES = {
  mtn: {
    name: 'MTN Share & Sell',
    code: '*321*{to}*{amount}*{pin}#',
    menu: 'Or dial *321# and follow the menu.',
    defaultPin: '0000',
    changePin: '*321*0000*NEWPIN*NEWPIN#',
    limits: '₦50 – ₦10,000 per transfer',
  },
  airtel: {
    name: 'Airtel Me2U',
    code: null, // menu only
    menu: 'Dial *321#, choose “Airtel to Airtel”, enter the number, amount and your PIN.',
    defaultPin: '1234',
    changePin: 'Dial *321# → PIN management → Change PIN',
    limits: 'From ₦50; Airtel sets daily limits',
  },
  glo: {
    name: 'Glo EasyShare',
    code: '*131*{to}*{amount}*{pin}#',
    menu: 'Or dial *321# and choose Easy Share.',
    defaultPin: '00000',
    changePin: '*132*00000*NEWPIN*NEWPIN#',
    limits: '₦50 – ₦5,000 per transfer',
  },
  etisalat: {
    name: 'T2 (9mobile) airtime transfer',
    code: '*223*{pin}*{amount}*{to}#',
    menu: 'If that doesn’t work, dial *321# and choose Airtime Transfer.',
    defaultPin: '0000',
    changePin: '*247*0000*NEWPIN#',
    limits: 'Small fee per transfer; network limits apply',
  },
};

module.exports = { CODES };
