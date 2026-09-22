const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { notify } = require('../lib/notify');

const router = express.Router();

// A customer's own complaints, most recent first — either general
// or tied to a specific order via the "Report Issue" button on that
// order's receipt.
router.get('/support/tickets', requireCustomerAuth, async (req, res) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { customerId: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ tickets });
  } catch (error) {
    console.error('GET /support/tickets failed:', error);
    res.status(500).json({ error: 'Could not load your support tickets.' });
  }
});

router.post('/support/tickets', requireCustomerAuth, async (req, res) => {
  try {
    const { message, orderId } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Please describe the issue.' });
    }

    if (orderId) {
      const order = await prisma.order.findFirst({
        where: { id: orderId, customerId: req.customer.customerId },
      });
      if (!order) return res.status(404).json({ error: 'Order not found.' });
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        customerId: req.customer.customerId,
        orderId: orderId || undefined,
        message: message.trim(),
      },
    });

    res.status(201).json({ ticket });
  } catch (error) {
    console.error('POST /support/tickets failed:', error);
    res.status(500).json({ error: 'Could not submit your report.' });
  }
});

// Admin: every complaint across all customers, most recent first,
// with just enough customer/order context to triage without a
// second lookup.
router.get('/admin/support/tickets', requireAdminAuth, async (req, res) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        order: { select: { id: true, service: true, recipient: true, amount: true, status: true, createdAt: true } },
      },
    });
    res.json({ tickets });
  } catch (error) {
    console.error('GET /admin/support/tickets failed:', error);
    res.status(500).json({ error: 'Could not load support tickets.' });
  }
});

router.patch('/admin/support/tickets/:id/resolve', requireAdminAuth, async (req, res) => {
  try {
    const ticket = await prisma.supportTicket.update({
      where: { id: req.params.id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });

    notify(ticket.customerId, 'Support Ticket Resolved', 'An admin has replied and marked your support ticket as resolved.');

    res.json({ ticket });
  } catch (error) {
    console.error('PATCH /admin/support/tickets/:id/resolve failed:', error);
    res.status(500).json({ error: 'Could not resolve this ticket.' });
  }
});

module.exports = router;
