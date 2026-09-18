const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth } = require('../lib/auth');

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

module.exports = router;
