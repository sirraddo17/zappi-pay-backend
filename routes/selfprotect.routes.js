const express = require('express');
const prisma = require('../lib/prisma');
const { comparePassword, requireCustomerAuth } = require('../lib/auth');
const { notify } = require('../lib/notify');

// "My phone was stolen": the customer freezes their own account. It
// logs out every device, removes quick login and blocks all logins
// and payments until support confirms who they are and unfreezes it.
const router = express.Router();

router.post('/security/freeze', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!customer) return res.status(404).json({ error: 'Account not found.' });
    if (!req.body?.password || !(await comparePassword(String(req.body.password), customer.passwordHash))) {
      return res.status(401).json({ error: 'That password is not correct.', code: 'BAD_PASSWORD' });
    }
    const now = new Date();
    await prisma.$transaction([
      prisma.customer.update({ where: { id: customer.id }, data: { active: false, selfFrozenAt: now, tokensValidAfter: now } }),
      prisma.loginSession.updateMany({ where: { customerId: customer.id, revokedAt: null }, data: { revokedAt: now } }),
      prisma.trustedDevice.deleteMany({ where: { customerId: customer.id } }),
    ]);
    require('../lib/sessions').forgetCustomer(customer.id);
    notify(customer.id, 'Account Frozen', 'You froze your ZAPPI PAY account. Nobody can log in or spend from it. Contact support to unfreeze it — we will confirm it is really you first.');
    require('../lib/adminAlert').alertAdmins('Customer froze their account', `${customer.name} (${customer.phone}) froze their own account (lost phone / suspected hacking). Unfreeze only after checking their date of birth and security question.`, `/admin/customers/${customer.id}`);
    await prisma.auditLog.create({ data: { actorAdminId: null, action: 'CUSTOMER_SELF_FREEZE', details: { customerId: customer.id } } }).catch(() => {});
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /security/freeze failed:', error);
    res.status(500).json({ error: 'Could not freeze the account. Call or WhatsApp support now.' });
  }
});

module.exports = router;
