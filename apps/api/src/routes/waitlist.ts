import { Router } from "express";
import { z } from "zod";
import { query } from "../db/index";
import { createError } from "../middleware/error";
import { apiLimiter, waitlistLimiter } from "../middleware/rate-limit";

import { optionalAuth } from "../middleware/authenticate";
import { scheduleChallengeReminder } from "../queues/challenge-reminder.queue";

const router = Router();

const WaitlistSchema = z.object({
  email: z.string().max(254).email(),
  referral_code: z.string().max(64).optional(),
  challenge_id: z.string().uuid().optional(),
  lead_time_minutes: z.coerce.number().int().min(1).max(10080).default(15).optional(),
});

router.post("/", optionalAuth, waitlistLimiter, async (req, res) => {
  const parsed = WaitlistSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError("Invalid email address", 422, "INVALID_EMAIL");
  }
  const email = parsed.data.email.toLowerCase().trim();
  const userId = req.user?.sub ?? null;

  await query(
    `INSERT INTO waitlist (email, referral_code)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, parsed.data.referral_code ?? null]
  );

  let reminderScheduled = false;
  let scheduledFor: Date | null = null;

  if (parsed.data.challenge_id) {
    const chRes = await query<{ id: string; status: string; starts_at: string }>(
      "SELECT id, status, starts_at FROM challenges WHERE id = $1",
      [parsed.data.challenge_id]
    );
    if (chRes.rows.length === 0) {
      throw createError("Challenge not found", 404);
    }
    if (chRes.rows[0].status === "cancelled" || chRes.rows[0].status === "refunded") {
      throw createError("Cannot register reminder for cancelled challenge", 400);
    }

    const startsAt = new Date(chRes.rows[0].starts_at);
    const leadTime = parsed.data.lead_time_minutes ?? 15;
    scheduledFor = new Date(startsAt.getTime() - leadTime * 60 * 1000);

    await query(
      `INSERT INTO challenge_reminders (challenge_id, user_id, email, lead_time_minutes, scheduled_for)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (challenge_id, email) DO UPDATE
       SET lead_time_minutes = EXCLUDED.lead_time_minutes,
           scheduled_for = EXCLUDED.scheduled_for,
           sent_at = NULL`,
      [parsed.data.challenge_id, userId, email, leadTime, scheduledFor]
    ).catch(() => null);

    await scheduleChallengeReminder({
      challengeId: parsed.data.challenge_id,
      userId: userId ?? undefined,
      email,
      leadTimeMinutes: leadTime,
      startsAt,
    }).catch(() => null);

    return res.status(201).json({
      message: "You're on the list!",
      reminderScheduled: true,
      scheduledFor,
    });
  }

  res.status(201).json({
    message: "You're on the list!",
  });
});

router.get("/position/:email", apiLimiter, async (req, res) => {
  const email = z.string().email().parse(req.params.email);
  const result = await query<{ position: number }>(
    `SELECT position FROM (
       SELECT email, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS position
       FROM waitlist
     ) w
     WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  if (result.rows.length === 0) {
    throw createError("Email not found on waitlist", 404);
  }

  res.json({ position: result.rows[0].position });
});

export default router;
