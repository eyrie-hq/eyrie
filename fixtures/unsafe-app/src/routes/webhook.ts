import express from 'express';

export const app = express();

/** Accepts Stripe events without verifying their signature. */
app.post('/webhooks/stripe', async (req, res) => {
  const event = req.body;
  console.log('received', event.type);
  res.json({ ok: true });
});
