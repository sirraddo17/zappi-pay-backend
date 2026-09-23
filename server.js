require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth.routes');
const walletRouter = require('./routes/wallet.routes');
const vtpassRouter = require('./routes/vtpass.routes');
const adminRouter = require('./routes/admin.routes');
const supportRouter = require('./routes/support.routes');
const notificationRouter = require('./routes/notification.routes');
const broadcastRouter = require('./routes/broadcast.routes');
const airtimeCashRouter = require('./routes/airtimecash.routes');

const app = express();

app.use(cors());
// Default is 100kb, far too small for a base64-encoded profile
// photo — raised to cover that (matched by the 2MB cap on the
// avatar field itself in auth.routes.js) without leaving the limit
// unbounded.
app.use(express.json({ limit: '3mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'zappi-pay-backend' }));

app.use('/api', authRouter);
app.use('/api', walletRouter);
app.use('/api', vtpassRouter);
app.use('/api', adminRouter);
app.use('/api', supportRouter);
app.use('/api', notificationRouter);
app.use('/api', broadcastRouter);
app.use('/api', airtimeCashRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`zappi-pay-backend listening on port ${PORT}`));
