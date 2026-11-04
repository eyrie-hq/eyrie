import express from 'express';
import { prisma } from '../lib/prisma';

export const app = express();

/** Anyone on the internet can write a note: no auth guard on this path. */
app.post('/api/notes', async (req, res) => {
  const note = await prisma.note.create({ data: { text: req.body.text } });
  res.json(note);
});
