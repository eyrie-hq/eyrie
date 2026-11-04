import express from 'express';
import Stripe from 'stripe';

export const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/** Safe variant: the signature is verified before the event is trusted. */
app.post('/webhooks/safe-stripe', async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, process.env.STRIPE_WEBHOOK_SECRET!);
  console.log('received', event.type);
  res.json({ ok: true });
});
