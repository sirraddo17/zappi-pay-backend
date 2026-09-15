require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth.routes');
const walletRouter = require('./routes/wallet.routes');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'zappi-pay-backend' }));

app.use('/api', authRouter);
app.use('/api', walletRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`zappi-pay-backend listening on port ${PORT}`));
