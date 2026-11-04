import express from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../lib/auth';

export const app = express();

/** Safe variant: the guard runs before the write. */
app.post('/api/safe-notes', requireAuth(), async (req, res) => {
  const note = await prisma.note.create({ data: { text: req.body.text } });
  res.json(note);
});
