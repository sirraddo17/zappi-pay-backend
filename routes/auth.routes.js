const express = require('express');
const prisma = require('../lib/prisma');
const {
  hashPassword,
  comparePassword,
  signAdminToken,
  signCustomerToken,
  requireCustomerAuth,
} = require('../lib/auth');

const router = express.Router();

function publicCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    username: customer.username,
    email: customer.email,
    walletBalance: customer.walletBalance,
    avatarUrl: customer.avatarUrl,
  };
}

// --- Customer auth ---

router.post('/auth/signup', async (req, res) => {
  try {
    const { name, phone, email, password, username } = req.body;
    if (!name || !phone || !password || !username) {
      return res.status(400).json({ error: 'name, phone, username, and password are required.' });
    }
    const normalizedUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(normalizedUsername)) {
      return res.status(400).json({ error: 'Username must be 3-20 characters, letters, numbers, and underscores only.' });
    }

    const existing = await prisma.customer.findFirst({
      where: { OR: [{ phone: phone.trim() }, { username: normalizedUsername }] },
    });
    if (existing) {
      return res.status(409).json({
        error: existing.phone === phone.trim()
          ? 'An account with this phone number already exists.'
          : 'This username is already taken.',
      });
    }

    const passwordHash = await hashPassword(password);
    const customer = await prisma.customer.create({
      data: {
        name: name.trim(),
        phone: phone.trim(),
        username: normalizedUsername,
        email: email ? email.trim() : undefined,
        passwordHash,
      },
    });

    const token = signCustomerToken(customer);
    res.status(201).json({ token, customer: publicCustomer(customer) });
  } catch (error) {
    console.error('POST /auth/signup failed:', error);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier and password are required.' });
    }
    const trimmedIdentifier = identifier.trim();

    const customer = await prisma.customer.findFirst({
      where: { OR: [{ phone: trimmedIdentifier }, { username: trimmedIdentifier.toLowerCase() }] },
    });
    if (!customer || !(await comparePassword(password, customer.passwordHash))) {
      return res.status(401).json({ error: 'Invalid phone/username or password.' });
    }
    if (!customer.active) {
      return res.status(403).json({ error: 'This account has been deactivated.' });
    }

    const token = signCustomerToken(customer);
    res.json({ token, customer: publicCustomer(customer) });
  } catch (error) {
    console.error('POST /auth/login failed:', error);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

router.get('/auth/me', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!customer) return res.status(404).json({ error: 'Account not found.' });
    res.json({ customer: publicCustomer(customer) });
  } catch (error) {
    console.error('GET /auth/me failed:', error);
    res.status(500).json({ error: 'Could not load account.' });
  }
});

router.patch('/auth/me', requireCustomerAuth, async (req, res) => {
  try {
    const { name, email, avatarUrl } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (email !== undefined) data.email = email.trim() || null;
    if (avatarUrl !== undefined) {
      // A generous cap on the base64 string itself (roughly a 1.5MB
      // image once decoded) — there's no separate file storage doing
      // resizing for this app, so this is what stops someone's phone
      // photo from bloating a database row unreasonably.
      if (avatarUrl && avatarUrl.length > 2_000_000) {
        return res.status(400).json({ error: 'Image is too large. Please choose a smaller photo.' });
      }
      data.avatarUrl = avatarUrl || null;
    }

    const customer = await prisma.customer.update({
      where: { id: req.customer.customerId },
      data,
    });
    res.json({ customer: publicCustomer(customer) });
  } catch (error) {
    console.error('PATCH /auth/me failed:', error);
    res.status(500).json({ error: 'Could not update account.' });
  }
});

// --- Admin auth ---
// No self-service signup on purpose — admin accounts are seeded
// directly, same pattern used across the other apps in this ecosystem.

router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const admin = await prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!admin || !(await comparePassword(password, admin.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!admin.active) {
      return res.status(403).json({ error: 'This admin account has been deactivated.' });
    }

    const token = signAdminToken(admin);
    res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch (error) {
    console.error('POST /admin/login failed:', error);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

router.patch('/auth/password', requireCustomerAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!customer || !(await comparePassword(currentPassword, customer.passwordHash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.customer.update({ where: { id: customer.id }, data: { passwordHash } });

    res.json({ success: true });
  } catch (error) {
    console.error('PATCH /auth/password failed:', error);
    res.status(500).json({ error: 'Could not change password.' });
  }
});

module.exports = router;
