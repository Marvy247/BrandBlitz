import { Router } from "express";
import { z } from "zod";
import { getChallengeById, getChallengeQuestions } from "../db/queries/challenges";
import {
  getSession,
  getSessionShareCard,
  markWarmupStarted,
  markWarmupCompleted,
  markChallengeStarted,
  recordRoundScore,
  finishSession,
  storeSessionHmac,
  deleteOpenSession,
  abandonSession,
} from "../db/queries/sessions";
import { calculateRoundScore, validateAnswer, validateRoundScore } from "../services/scoring";
import { authenticate } from "../middleware/authenticate";
import { requireActiveUser } from "../middleware/require-active-user";
import {
  enforceOneSessionPerChallenge,
  validateReactionTime,
  validateDeviceFingerprint,
  detectClockSkew,
  assertValidTotalScore,
  requireSessionStartAllowed,
} from "../middleware/anti-cheat";
import { createError } from "../middleware/error";
import { challengeStartLimiter } from "../middleware/rate-limit";
import { redis } from "../lib/redis";
import { computeSessionHmac } from "../lib/integrity";
import { updateStreak } from "../services/streaks";
import { checkAndAwardSessionBadges } from "../services/badges";
import { notifyOvertakenParticipants } from "../services/rank-overtaken";
import { WARMUP_MIN_SECONDS } from "@brandblitz/stellar";
import { tokenRevocationKey, tokenTtlSeconds } from "../middleware/authenticate";
import { revalidateLeaderboard } from "../lib/revalidate";
import { query } from "../db/index";

const router = Router();

function bearerToken(req: { headers: { authorization?: string } }): string | null {
  const authHeader = req.headers.authorization;
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

async function revokeSessionToken(sessionId: string, token: string, exp: number): Promise<void> {
  await redis.del(`session-token:${sessionId}`);
  await redis.del(`session:start:${sessionId}`);
  await redis.set(
    tokenRevocationKey(token),
    "1",
    "EX",
    tokenTtlSeconds({ sub: "", email: "", iat: 0, exp })
  );
}

const AnswerSchema = z.object({
  selectedOption: z.enum(["A", "B", "C", "D"]).nullable(),
  reactionTimeMs: z.number().int().min(0),
});

function lastAnsweredRound(session: {
  round_1_answer?: string | null;
  round_1_score?: number;
  round_2_answer?: string | null;
  round_2_score?: number;
  round_3_answer?: string | null;
  round_3_score?: number;
}): 0 | 1 | 2 | 3 {
  if (session.round_3_answer || (session.round_3_score ?? 0) > 0) return 3;
  if (session.round_2_answer || (session.round_2_score ?? 0) > 0) return 2;
  if (session.round_1_answer || (session.round_1_score ?? 0) > 0) return 1;
  return 0;
}

function recoveryStatus(session: {
  status?: string;
  completed_at?: string | Date | null;
  challenge_started_at?: string | Date | null;
}): "warmup" | "in_progress" | "completed" | "expired" {
  if (session.completed_at || session.status === "completed") return "completed";
  if (session.status === "abandoned") return "expired";
  if (session.challenge_started_at || session.status === "active") return "in_progress";
  return "warmup";
}

function remainingTimeMs(session: { challenge_started_at?: string | Date | null }): number {
  if (!session.challenge_started_at) return 45_000;
  const startedAt = new Date(session.challenge_started_at).getTime();
  if (!Number.isFinite(startedAt)) return 45_000;
  return Math.max(0, 45_000 - (Date.now() - startedAt));
}

/**
 * GET /sessions/:id/share-card
 * Public, shareable result-card data for a completed session (#1011).
 * Deliberately unauthenticated -- this is what a share link resolves to --
 * so the query behind it excludes practice runs, flagged sessions, and any
 * PII beyond display name/avatar.
 */
router.get("/:id/share-card", async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const card = await getSessionShareCard(id);
  if (!card) throw createError("Result not found or not shareable", 404, "NOT_FOUND");

  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  res.json({
    sessionId: card.session_id,
    challengeId: card.challenge_id,
    brandName: card.brand_name,
    logoUrl: card.logo_url,
    primaryColor: card.primary_color,
    secondaryColor: card.secondary_color,
    totalScore: card.total_score,
    rank: card.rank,
    completedAt: card.completed_at,
    player: {
      displayName: card.display_name,
      username: card.username,
      avatarUrl: card.avatar_url,
    },
  });
});

/**
 * GET /sessions/:challengeId
 * Return the authenticated user's current session progress for recovery UI.
 */
router.get("/:challengeId", authenticate, async (req, res) => {
  const challengeId = String(req.params.challengeId);
  const challenge = await getChallengeById(challengeId);
  if (!challenge) throw createError("Challenge not found", 404);

  const session = await getSession(req.user!.sub, challenge.id);
  if (!session) throw createError("Session not found", 404);
  if (session.user_id !== req.user!.sub) throw createError("Forbidden", 403);

  const lastRound = lastAnsweredRound(session);
  const totalScore =
    session.total_score ||
    (session.round_1_score ?? 0) + (session.round_2_score ?? 0) + (session.round_3_score ?? 0);

  res.json({
    session: {
      id: session.id,
      status: recoveryStatus(session),
      last_answered_round: lastRound,
      current_round: Math.min(lastRound + 1, 3),
      remaining_time_ms: remainingTimeMs(session),
      total_score: totalScore,
      round_scores: [session.round_1_score, session.round_2_score, session.round_3_score],
    },
  });
});

/**
 * DELETE /sessions/:challengeId
 * Explicitly quit an active or warmup session, recording abandon_reason = 'explicit'.
 * The row is soft-abandoned (not deleted) so the reason is preserved for analytics
 * and fraud detection. A subsequent warmup-start call will detect the abandoned
 * session and create a fresh one via enforceOneSessionPerChallenge.
 */
router.delete("/:challengeId", authenticate, async (req, res) => {
  const challengeId = String(req.params.challengeId);
  const challenge = await getChallengeById(challengeId);
  if (!challenge) throw createError("Challenge not found", 404);

  const abandoned = await abandonSession(req.user!.sub, challenge.id, "explicit");
  if (!abandoned) throw createError("No open session to forfeit", 404);

  res.status(204).send();
});

/**
 * POST /sessions/:challengeId/warmup-start
 * Begin the warm-up phase. Records start time server-side.
 * Uses DB UNIQUE constraint to atomically create the session (no race).
 */
router.post(
  "/:challengeId/warmup-start",
  authenticate,
  requireActiveUser,
  enforceOneSessionPerChallenge,
  validateDeviceFingerprint,
  async (req, res) => {
    const challengeId = String(req.params.challengeId);
    const challenge = await getChallengeById(challengeId);
    if (!challenge || challenge.status !== "active") {
      throw createError("Challenge not available", 404);
    }

    const session = (req as any).session;
    if (!session) throw createError("Session not found", 404);

    await markWarmupStarted(session.id);

    // Store warmup unlock time in Redis (server enforces minimum exposure)
    const unlockAt = Date.now() + WARMUP_MIN_SECONDS * 1000;
    await redis.set(`warmup:unlock:${session.id}`, unlockAt.toString(), "EX", 300);

    res.json({ sessionId: session.id, unlockAt });
  }
);

/**
 * POST /sessions/:challengeId/warmup-complete
 * Completes warm-up and issues a short-lived challenge token.
 * Server enforces that minimum exposure time has passed using server-side timestamp.
 */
router.post("/:challengeId/warmup-complete", authenticate, detectClockSkew, async (req, res) => {
  const challengeId = String(req.params.challengeId);
  const challenge = await getChallengeById(challengeId);
  if (!challenge) throw createError("Challenge not found", 404);

  const session = await getSession(req.user!.sub, challenge.id);
  if (!session) throw createError("Session not found", 404);
  if (session.user_id !== req.user!.sub) throw createError("Forbidden", 403);

  // Enforce server-side warmup minimum using server timestamp only
  const unlockAt = await redis.get(`warmup:unlock:${session.id}`);
  if (unlockAt) {
    const serverNow = Date.now();
    const remainingMs = parseInt(unlockAt) - serverNow;
    if (remainingMs > 0) {
      const error = createError("Warm-up minimum not yet elapsed", 400, "WARMUP_TOO_FAST");
      (error as any).remainingMs = remainingMs;
      throw error;
    }
  }

  await markWarmupCompleted(session.id);

  // Issue a short-lived challenge token (10 min TTL)
  const challengeToken = `ct:${session.id}:${Date.now()}`;
  await redis.set(`challenge-token:${challengeToken}`, session.id, "EX", 600);

  res.json({ challengeToken });
});

/**
 * POST /sessions/:challengeId/start
 * Start the challenge timer. Validates challenge token from warmup-complete.
 */
router.post(
  "/:challengeId/start",
  authenticate,
  requireActiveUser,
  challengeStartLimiter,
  requireSessionStartAllowed,
  async (req, res) => {
    const { challengeToken } = z.object({ challengeToken: z.string() }).parse(req.body);
    const challengeId = String(req.params.challengeId);
    const challenge = await getChallengeById(challengeId);
    if (!challenge) throw createError("Challenge not found", 404);

    // Validate challenge token
    const storedSessionId = await redis.get(`challenge-token:${challengeToken}`);
    if (!storedSessionId) throw createError("Invalid or expired challenge token", 401);

    const session = await getSession(req.user!.sub, challenge.id);
    if (!session || session.id !== storedSessionId) throw createError("Session mismatch", 403);

    await markChallengeStarted(session.id);
    await query("UPDATE users SET last_active_at = NOW() WHERE id = $1", [req.user!.sub]);
    await redis.del(`challenge-token:${challengeToken}`);

    // Store session start time for timing validation
    await redis.set(`session:start:${session.id}`, Date.now().toString(), "EX", 120);
    const token = bearerToken(req);
    if (token) {
      await redis.set(`session-token:${session.id}`, token, "EX", 600);
    }

    res.json({ sessionId: session.id, startsAt: new Date().toISOString() });
  }
);

/**
 * POST /sessions/:challengeId/answer/:round
 * Submit an answer for a round. Validates + scores server-side.
 * Correct answers are NEVER sent to the client.
 * Round-3 is idempotent: duplicate requests return the cached result.
 */
router.post(
  "/:challengeId/answer/:round",
  authenticate,
  validateReactionTime,
  async (req, res) => {
    const challengeId = String(req.params.challengeId);
    const round = parseInt(String(req.params.round)) as 1 | 2 | 3;
    if (![1, 2, 3].includes(round)) throw createError("Invalid round", 400);

    const body = AnswerSchema.parse(req.body);
    const challenge = await getChallengeById(challengeId);
    if (!challenge) throw createError("Challenge not found", 404);

    const session = await getSession(req.user!.sub, challenge.id);
    if (!session) throw createError("Session not found", 404);
    if (session.user_id !== req.user!.sub) throw createError("Forbidden", 403);
    if (!session.challenge_started_at) throw createError("Challenge not started", 400);

    if (session.completed_at && round !== 3) {
      throw createError("Session already completed", 409);
    }
    if ((session as any).is_flagged || session.flagged) {
      throw createError("Session flagged for review", 403);
    }

    // Double answer check
    const alreadyAnswered =
      round === 1 ? session.round_1_answer != null
      : round === 2 ? session.round_2_answer != null
      : session.round_3_answer != null;
    if (alreadyAnswered) {
      throw createError("Round already answered", 400);
    }

    const questions = await getChallengeQuestions(challenge.id);
    const question = questions.find((q) => q.round === round);
    if (!question) throw createError("Question not found", 404);

    if (session.completed_at && round === 3) {
      if (session.round_3_answer !== body.selectedOption) {
        throw createError("Answer conflict detected", 409, "CONFLICT_REPLAY");
      }
      return res.json({
        correct: validateAnswer(question, body.selectedOption),
        score: session.round_3_score,
        round: 3,
        total_score: session.total_score,
        rank: session.rank ?? null,
      });
    }

    const score = calculateRoundScore({
      selectedOption: body.selectedOption,
      correctOption: question.correct_option,
      reactionTimeMs: body.reactionTimeMs,
    });

    const scoreCheck = validateRoundScore(score);
    if (!scoreCheck.valid) {
      throw createError(scoreCheck.message, 422, scoreCheck.code);
    }

    await recordRoundScore(session.id, round, score, body.selectedOption, body.reactionTimeMs);

    // Set when round 3 finishes the session, so the client can build a
    // shareable result-card link (#1011) without a separate round trip.
    let sessionIdForShareCard: string | undefined;

    if (round === 3) {
      const completed = await finishSession(session.id);
      if (completed) {
        sessionIdForShareCard = completed.is_practice ? undefined : completed.id;
        assertValidTotalScore(completed.total_score);
        const hmac = computeSessionHmac(completed.id, completed.total_score, completed.completed_at!);
        if (hmac) {
          await storeSessionHmac(session.id, hmac);
        }
        if (!completed.is_practice) {
          await updateStreak(completed.user_id);
          await checkAndAwardSessionBadges(completed.user_id, {
            total_score: completed.total_score,
            is_practice: completed.is_practice,
          });
          
          // Invalidate Redis leaderboard cache
          const keys = await redis.keys("leaderboard:*");
          if (keys.length > 0) {
            await redis.del(...keys);
          }
          await revalidateLeaderboard().catch(() => {});

          // Notify any participants that were overtaken by this score (fire-and-forget)
          void notifyOvertakenParticipants(
            completed.user_id,
            completed.challenge_id,
            completed.total_score,
            challenge.challenge_id
          );
        }
        const token = bearerToken(req);
        if (token) {
          await revokeSessionToken(session.id, token, req.user!.exp);
        }
      }
      const token = bearerToken(req);
      if (token) {
        await revokeSessionToken(session.id, token, req.user!.exp);
      }
    }

    res.json({
      correct: validateAnswer(question, body.selectedOption),
      score,
      round,
      sessionId: sessionIdForShareCard,
    });
  }
);

export default router;
