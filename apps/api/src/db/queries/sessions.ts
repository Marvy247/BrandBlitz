import type { PoolClient } from "pg";
import { pool, query } from "../index";
import { encodeCursor, buildCursorWhereSimple, decodeCursorSafe } from "../pagination";

export interface GameSession {
  id: string;
  user_id: string;
  challenge_id: string;
  device_id: string | null;
  status: "warmup" | "active" | "completed" | "flagged" | "abandoned";
  warmup_started_at: string | null;
  warmup_completed_at: string | null;
  challenge_started_at: string | null;
  completed_at: string | null;
  round_1_answer: string | null;
  round_1_score: number;
  round_2_answer: string | null;
  round_2_score: number;
  round_3_answer: string | null;
  round_3_score: number;
  total_score: number;
  rank: number | null;
  flagged: boolean;
  flag_reasons: string[] | null;
  is_practice: boolean;
  integrity_hmac: string | null;
  variant_id: string | null;
  tier_id: string | null;
  abandon_reason: "timeout" | "error" | "explicit" | null;
  created_at: string;
}

export interface RoundScore {
  id: string;
  session_id: string;
  round: 1 | 2 | 3;
  score: number;
  reaction_time_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface LeaderboardSession extends GameSession {
  username: string;
  avatar_url: string;
  display_name: string;
  league: "bronze" | "silver" | "gold" | null;
  total_earned_usdc: string;
  stellar_address: string | null;
}

export const LEADERBOARD_SORTS = ["score", "rank", "created_at"] as const;
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number];

const leaderboardOrderBy: Record<LeaderboardSort, string> = {
  score: "gs.total_score DESC, gs.completed_at ASC, gs.id ASC",
  rank: "gs.total_score DESC, gs.completed_at ASC, gs.id ASC",
  created_at: "gs.created_at DESC, gs.total_score DESC, gs.id ASC",
};

export async function createSession(data: {
  userId: string;
  challengeId: string;
  deviceId?: string;
  isPractice?: boolean;
}): Promise<GameSession> {
  const result = await query<GameSession>(
    `INSERT INTO game_sessions (user_id, challenge_id, device_id, is_practice)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, challenge_id) DO UPDATE
       SET user_id = game_sessions.user_id
     RETURNING *`,
    [data.userId, data.challengeId, data.deviceId ?? null, data.isPractice ?? false]
  );
  return result.rows[0];
}

export async function claimSession(data: {
  userId: string;
  challengeId: string;
  deviceId?: string;
  isPractice?: boolean;
  variantId?: string | null;
  tierId?: string | null;
}): Promise<GameSession | null> {
  const result = await query<GameSession>(
    `INSERT INTO game_sessions (user_id, challenge_id, device_id, is_practice, variant_id, tier_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, challenge_id) DO NOTHING
     RETURNING *`,
    [data.userId, data.challengeId, data.deviceId ?? null, data.isPractice ?? false, data.variantId ?? null, data.tierId ?? null]
  );
  return result.rows[0] ?? null;
}

export async function getSession(userId: string, challengeId: string): Promise<GameSession | null> {
  const result = await query<GameSession>(
    "SELECT * FROM game_sessions WHERE user_id = $1 AND challenge_id = $2",
    [userId, challengeId]
  );
  return result.rows[0] ?? null;
}

export interface SessionShareCard {
  session_id: string;
  challenge_id: string;
  brand_name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  total_score: number;
  rank: number | null;
  completed_at: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
}

/**
 * Public, shareable summary of a completed session (#1011). Excludes
 * practice runs and flagged sessions, and never exposes email -- this is
 * meant to be rendered on a public share card/link.
 */
export async function getSessionShareCard(sessionId: string): Promise<SessionShareCard | null> {
  const result = await query<SessionShareCard>(
    `SELECT gs.id AS session_id,
            gs.challenge_id,
            b.name AS brand_name,
            b.logo_url,
            b.primary_color,
            b.secondary_color,
            gs.total_score,
            gs.rank,
            gs.completed_at,
            u.display_name,
            u.username,
            u.avatar_url
     FROM game_sessions gs
     JOIN challenges c ON c.id = gs.challenge_id
     JOIN brands b ON b.id = c.brand_id
     JOIN users u ON u.id = gs.user_id
     WHERE gs.id = $1
       AND gs.completed_at IS NOT NULL
       AND gs.is_practice = FALSE
       AND gs.flagged = FALSE`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export async function deleteOpenSession(userId: string, challengeId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM game_sessions
     WHERE user_id = $1
       AND challenge_id = $2
       AND status IN ('warmup', 'active', 'abandoned')
     RETURNING id`,
    [userId, challengeId]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function markWarmupStarted(sessionId: string): Promise<void> {
  await query(
    "UPDATE game_sessions SET warmup_started_at = COALESCE(warmup_started_at, NOW()) WHERE id = $1",
    [sessionId]
  );
}

export async function markWarmupCompleted(sessionId: string): Promise<void> {
  const result = await query(
    `UPDATE game_sessions
     SET warmup_completed_at = NOW()
     WHERE id = $1
       AND warmup_completed_at IS NULL
     RETURNING id`,
    [sessionId]
  );

  if (result.rowCount === 0) {
    throw new Error("Warmup already completed or session not found");
  }
}

export async function markChallengeStarted(sessionId: string): Promise<void> {
  await query(
    `UPDATE game_sessions
     SET challenge_started_at = COALESCE(challenge_started_at, NOW()),
         status = 'active'
     WHERE id = $1`,
    [sessionId]
  );
}

async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordRoundScore(
  sessionId: string,
  round: 1 | 2 | 3,
  score: number,
  answer: string | null = null,
  reactionTimeMs: number | null = null
): Promise<void> {
  if (![1, 2, 3].includes(round)) {
    throw new Error("Invalid round");
  }

  const roundColumn = `round_${round}_score`;
  const answerColumn = `round_${round}_answer`;
  const reactionColumn = `round_${round}_reaction_ms`;

  await query(
    `WITH upserted AS (
       INSERT INTO session_round_scores (session_id, round, score, answer, reaction_time_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, round) DO UPDATE
         SET score = EXCLUDED.score,
             answer = EXCLUDED.answer,
             reaction_time_ms = EXCLUDED.reaction_time_ms
       RETURNING session_id, score, answer, reaction_time_ms
     )
     UPDATE game_sessions
     SET ${roundColumn} = (SELECT score FROM upserted),
         ${answerColumn} = (SELECT answer FROM upserted),
         ${reactionColumn} = (SELECT reaction_time_ms FROM upserted)
     WHERE id = $1`,
    [sessionId, round, score, answer, reactionTimeMs]
  );
}

export async function finishSession(sessionId: string): Promise<GameSession> {
  return withTransaction<GameSession>(async (client) => {
    const sessionResult = await client.query<GameSession>(
      `SELECT *
       FROM game_sessions
       WHERE id = $1
       FOR UPDATE`,
      [sessionId]
    );
    const current = sessionResult.rows[0];
    if (!current) {
      throw new Error("Session not found");
    }

    if (current.completed_at) {
      return current;
    }

    const totalResult = await client.query<{ total_score: number }>(
      `SELECT COALESCE(SUM(score)::int, 0) AS total_score
       FROM session_round_scores
       WHERE session_id = $1`,
      [sessionId]
    );
    const totalScore = totalResult.rows[0]?.total_score ?? 0;

    const finishedResult = await client.query<GameSession>(
      `UPDATE game_sessions
       SET completed_at = NOW(),
           status = 'completed',
           total_score = $2
       WHERE id = $1
       RETURNING *`,
      [sessionId, totalScore]
    );
    const finished = finishedResult.rows[0];
    if (!finished) {
      throw new Error("Session not found");
    }

    await client.query(
      `UPDATE users
       SET total_score = total_score + $2,
           challenges_played = challenges_played + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [finished.user_id, finished.total_score]
    );

    return finished;
  });
}

export async function storeSessionHmac(sessionId: string, hmac: string): Promise<void> {
  await query("UPDATE game_sessions SET integrity_hmac = $1 WHERE id = $2", [hmac, sessionId]);
}

export async function flagSession(sessionId: string, reasons: string[]): Promise<void> {
  await query(
    `UPDATE game_sessions
     SET flagged = TRUE,
         status = 'flagged',
         flag_reasons = array_cat(COALESCE(flag_reasons, '{}'), $1::text[])
     WHERE id = $2`,
    [reasons, sessionId]
  );
}

export async function abandonSession(
  userId: string,
  challengeId: string,
  reason: "timeout" | "error" | "explicit"
): Promise<boolean> {
  const result = await query(
    `UPDATE game_sessions
     SET status = 'abandoned',
         abandon_reason = $3,
         completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
     WHERE user_id = $1
       AND challenge_id = $2
       AND status IN ('warmup', 'active')
     RETURNING id`,
    [userId, challengeId, reason]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markAbandonedSessions(): Promise<number> {
  const result = await query<{ count: number }>(
    `WITH abandoned AS (
       UPDATE game_sessions
       SET status = 'abandoned',
           abandon_reason = 'timeout',
           completed_at = COALESCE(completed_at, NOW()),
           updated_at = NOW()
       WHERE status IN ('warmup', 'active')
         AND COALESCE(challenge_started_at, warmup_started_at, created_at) < NOW() - INTERVAL '2 hours'
       RETURNING id
     )
     SELECT COUNT(*)::int AS count FROM abandoned`
  );

  return result.rows[0]?.count ?? 0;
}

export const LEADERBOARD_WINDOWS = ["daily", "weekly", "all-time"] as const;
export type LeaderboardWindow = (typeof LEADERBOARD_WINDOWS)[number];

/** How far back `completed_at` must fall for each time-window filter (#1006). */
const LEADERBOARD_WINDOW_INTERVALS: Record<Exclude<LeaderboardWindow, "all-time">, string> = {
  daily: "1 day",
  weekly: "7 days",
};

export async function getLeaderboard(
  challengeId: string,
  limit = 20,
  cursor?: string,
  sortBy: LeaderboardSort = "score",
  friendUserIds?: string[],
  window: LeaderboardWindow = "all-time",
  tierId?: string,
  viewerUserId?: string
): Promise<{ sessions: LeaderboardSession[]; nextCursor: string | null }> {
  const orderBy = leaderboardOrderBy[sortBy];
  const cursorValues = decodeCursorSafe(cursor, ["total_score", "completed_at", "id"]);
  const scoreDir = sortBy === "score" ? "DESC" : "ASC";
  const scoreOp = sortBy === "score" ? "<" : ">";

  let whereExtra = "";
  const params: unknown[] = [challengeId];

  if (friendUserIds && friendUserIds.length > 0) {
    whereExtra += ` AND gs.user_id = ANY($${params.length + 1}::uuid[])`;
    params.push(friendUserIds);
  }

  if (window !== "all-time") {
    whereExtra += ` AND gs.completed_at >= NOW() - INTERVAL '${LEADERBOARD_WINDOW_INTERVALS[window]}'`;
  }

  if (tierId) {
    whereExtra += ` AND gs.tier_id = $${params.length + 1}`;
    params.push(tierId);
  }

  if (viewerUserId) {
    whereExtra += ` AND NOT EXISTS (
      SELECT 1 FROM user_blocks ub
      WHERE (ub.blocker_id = $${params.length + 1} AND ub.blocked_id = gs.user_id)
         OR (ub.blocked_id = $${params.length + 1} AND ub.blocker_id = gs.user_id)
    )`;
    params.push(viewerUserId);
  }

  if (cursorValues) {
    const score = cursorValues.total_score;
    const completedAt = cursorValues.completed_at;
    const id = cursorValues.id as string;
    whereExtra += ` AND (gs.total_score ${scoreOp} $${params.length + 1} OR (gs.total_score = $${params.length + 1} AND (gs.completed_at > $${params.length + 2} OR (gs.completed_at = $${params.length + 2} AND gs.id > $${params.length + 3}))))`;
    params.push(score, completedAt, id);
  }

  params.push(limit);

  const result = await query<LeaderboardSession>(
    `SELECT gs.*,
            u.username AS username,
            u.avatar_url,
            u.display_name,
            u.league,
            u.total_earned_usdc,
            COALESCE(
              NULLIF(to_jsonb(u) ->> 'embedded_wallet_address', ''),
              NULLIF(to_jsonb(u) ->> 'stellar_address', '')
            ) AS stellar_address
     FROM game_sessions gs
     JOIN users u ON gs.user_id = u.id
     WHERE gs.challenge_id = $1
       AND gs.flagged = FALSE
       AND gs.is_practice = FALSE
       AND gs.status = 'completed'
       AND u.deleted_at IS NULL
     ${whereExtra}
     ORDER BY ${orderBy}, gs.id ASC
     LIMIT $${params.length}`,
    params
  );

  const sessions = result.rows;
  const nextCursor: string | null =
    sessions.length === limit
      ? encodeCursor({
          total_score: sessions[sessions.length - 1].total_score,
          completed_at: sessions[sessions.length - 1].completed_at,
          id: sessions[sessions.length - 1].id,
        })
      : null;

  return { sessions, nextCursor };
}

export async function getLeaderboardForCsvExport(
  challengeId: string,
  limit = 500,
  cursor?: string
): Promise<{
  sessions: Array<{
    user_id: string;
    username: string;
    display_name: string;
    total_score: number;
    completed_at: string | null;
    payout_amount_usdc: string;
  }>;
  nextCursor: string | null;
}> {
  const cursorValues = decodeCursorSafe(cursor, ["total_score", "completed_at", "id"]);
  let whereExtra = "";
  const params: unknown[] = [challengeId];

  if (cursorValues) {
    const score = cursorValues.total_score;
    const completedAt = cursorValues.completed_at;
    const id = cursorValues.id as string;
    whereExtra = `AND (gs.total_score < $${params.length + 1} OR (gs.total_score = $${params.length + 1} AND (gs.completed_at > $${params.length + 2} OR (gs.completed_at = $${params.length + 2} AND gs.id > $${params.length + 3}))))`;
    params.push(score, completedAt, id);
  }

  params.push(limit);

  const result = await query<{
    user_id: string;
    username: string;
    display_name: string;
    total_score: number;
    completed_at: string | null;
    payout_amount_usdc: string;
    id: string;
  }>(
    `SELECT gs.id,
            gs.user_id,
            gs.total_score,
            gs.completed_at,
            u.username AS username,
            u.display_name,
            COALESCE((p.amount_stroops::numeric / 10000000)::numeric(20,7)::text, '0') AS payout_amount_usdc
     FROM game_sessions gs
     JOIN users u ON gs.user_id = u.id
     LEFT JOIN payouts p ON p.challenge_id = gs.challenge_id AND p.user_id = gs.user_id
     WHERE gs.challenge_id = $1
       AND gs.flagged = FALSE
       AND gs.is_practice = FALSE
       AND gs.status = 'completed'
       AND u.deleted_at IS NULL
     ${whereExtra}
     ORDER BY gs.total_score DESC, gs.completed_at ASC, gs.id ASC
     LIMIT $${params.length}`,
    params
  );

  const sessions = result.rows;
  const nextCursor: string | null =
    sessions.length === limit
      ? encodeCursor({
          total_score: sessions[sessions.length - 1].total_score,
          completed_at: sessions[sessions.length - 1].completed_at,
          id: sessions[sessions.length - 1].id,
        })
      : null;

  return { sessions, nextCursor };
}

export async function getTopSessionsPerChallenge(
  challengeIds: string[],
  limitPerChallenge = 10
): Promise<LeaderboardSession[]> {
  if (challengeIds.length === 0) {
    return [];
  }

  const result = await query<LeaderboardSession & { challenge_rank: number }>(
    `WITH ranked AS (
       SELECT gs.*,
              u.username AS username,
              u.avatar_url,
              u.display_name,
              u.league,
              u.total_earned_usdc,
              COALESCE(
                NULLIF(to_jsonb(u) ->> 'embedded_wallet_address', ''),
                NULLIF(to_jsonb(u) ->> 'stellar_address', '')
              ) AS stellar_address,
              ROW_NUMBER() OVER (
                PARTITION BY gs.challenge_id
                ORDER BY gs.total_score DESC, gs.completed_at ASC
              ) AS challenge_rank
       FROM game_sessions gs
       JOIN users u ON gs.user_id = u.id
       WHERE gs.challenge_id = ANY($1::uuid[])
         AND gs.flagged = FALSE
         AND gs.is_practice = FALSE
         AND gs.status = 'completed'
         AND u.deleted_at IS NULL
     )
     SELECT *
     FROM ranked
     WHERE challenge_rank <= $2
     ORDER BY challenge_id ASC, challenge_rank ASC`,
    [challengeIds, limitPerChallenge]
  );

  return result.rows;
}

export interface GlobalLeaderboardRow {
  challenge_id: string;
  rank: number;
  user_id: string;
  username: string;
  display_name: string;
  league: "bronze" | "silver" | "gold" | null;
  avatar_url: string | null;
  total_score: number;
  total_earned_usdc: string;
}

export async function getGlobalLeaderboardFromView(
  challengeIds: string[],
  limitPerChallenge = 10
): Promise<GlobalLeaderboardRow[]> {
  if (challengeIds.length === 0) return [];
  const result = await query<GlobalLeaderboardRow>(
    `SELECT challenge_id, rank, user_id, username, display_name, league, avatar_url,
            total_score, total_earned_usdc
     FROM v_leaderboard_global
     WHERE challenge_id = ANY($1::uuid[]) AND rank <= $2
     ORDER BY challenge_id ASC, rank ASC`,
    [challengeIds, limitPerChallenge]
  );
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session History
// ─────────────────────────────────────────────────────────────────────────────

export type HistoryStatusFilter = "completed" | "disqualified" | "all";

export interface HistoryRound {
  round: 1 | 2 | 3;
  answer: string | null;
  score: number;
  reaction_time_ms: number | null;
}

export interface HistoryItem {
  session_id: string;
  challenge_id: string;
  challenge_title: string | null;
  started_at: string | null;
  completed_at: string | null;
  total_score: number;
  /**
   * Outcome:
   *   won           — status=completed, not flagged, payout.status=completed
   *   lost          — status=completed, not flagged, no completed payout
   *   disqualified  — flagged=true (status=flagged)
   *   in_progress   — warmup | active | abandoned (only included when status=all)
   */
  outcome: "won" | "lost" | "disqualified" | "in_progress";
  payout_amount_usdc: string | null;
  rounds?: HistoryRound[];
}

/**
 * Fetch paginated session history for a single user.
 *
 * @param userId        — must match game_sessions.user_id (ownership enforced in SQL)
 * @param opts.status   — "completed" | "disqualified" | "all"  (default: "completed")
 * @param opts.cursor   — opaque keyset cursor from a previous response
 * @param opts.limit    — page size, 1–100 (default 20)
 * @param opts.includeRounds — whether to join session_round_scores
 */
export async function getSessionHistory(
  userId: string,
  opts: {
    status?: HistoryStatusFilter;
    cursor?: string;
    limit?: number;
    includeRounds?: boolean;
  } = {}
): Promise<{ items: HistoryItem[]; nextCursor: string | null }> {
  const { status = "completed", cursor, limit = 20, includeRounds = false } = opts;

  // ── Status filter ────────────────────────────────────────────────────────
  let statusClause: string;
  if (status === "completed") {
    // Completed + not flagged only; excludes in-progress (warmup/active/abandoned)
    statusClause = "gs.status = 'completed' AND gs.flagged = FALSE";
  } else if (status === "disqualified") {
    statusClause = "gs.flagged = TRUE";
  } else {
    // all — every session belonging to the user
    statusClause = "TRUE";
  }

  // ── Cursor ───────────────────────────────────────────────────────────────
  const params: unknown[] = [userId];
  let cursorClause = "";

  if (cursor) {
    const decoded = decodeCursorSafe(cursor, ["completed_at", "id"]);
    if (decoded !== null) {
      const completedAt = decoded.completed_at;
      const id = decoded.id;
      // Rows older than the cursor (completed_at DESC, id DESC)
      params.push(completedAt, id);
      cursorClause = `AND (
        gs.completed_at < $${params.length - 1}
        OR (gs.completed_at = $${params.length - 1} AND gs.id < $${params.length}::uuid)
        OR gs.completed_at IS NULL
      )`;
    }
  }

  params.push(limit + 1);
  const limitParam = `$${params.length}`;

  // ── Main query ───────────────────────────────────────────────────────────
  const sql = `
    SELECT
      gs.id                        AS session_id,
      gs.challenge_id,
      c.challenge_id               AS challenge_title,
      gs.challenge_started_at      AS started_at,
      gs.completed_at,
      gs.total_score,
      gs.flagged,
      gs.status,
      -- Outcome derivation
      CASE
        WHEN gs.flagged = TRUE                         THEN 'disqualified'
        WHEN gs.status = 'completed'
             AND p.status = 'completed'               THEN 'won'
        WHEN gs.status = 'completed'                  THEN 'lost'
        ELSE                                               'in_progress'
      END                          AS outcome,
      -- Payout (NULL when no completed payout exists)
      CASE
        WHEN p.status = 'completed'
          THEN (p.amount_stroops::numeric / 10000000)::numeric(20,7)::text
        ELSE NULL
      END                          AS payout_amount_usdc
    FROM game_sessions gs
    JOIN challenges c ON gs.challenge_id = c.id
    LEFT JOIN payouts p ON p.session_id = gs.id AND p.status = 'completed'
    WHERE gs.user_id = $1
      AND ${statusClause}
      ${cursorClause}
    ORDER BY gs.completed_at DESC NULLS LAST, gs.id DESC
    LIMIT ${limitParam}
  `;

  const result = await query<{
    session_id: string;
    challenge_id: string;
    challenge_title: string | null;
    started_at: string | null;
    completed_at: string | null;
    total_score: number;
    flagged: boolean;
    status: string;
    outcome: "won" | "lost" | "disqualified" | "in_progress";
    payout_amount_usdc: string | null;
  }>(sql, params);

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);

  // ── Round scores (optional) ──────────────────────────────────────────────
  let roundsBySession: Map<string, HistoryRound[]> = new Map();

  if (includeRounds && rows.length > 0) {
    const sessionIds = rows.map((r) => r.session_id);
    const roundResult = await query<{
      session_id: string;
      round: 1 | 2 | 3;
      answer: string | null;
      score: number;
      reaction_time_ms: number | null;
    }>(
      `SELECT session_id, round, answer, score, reaction_time_ms
       FROM session_round_scores
       WHERE session_id = ANY($1::uuid[])
       ORDER BY session_id, round`,
      [sessionIds]
    );

    for (const row of roundResult.rows) {
      const existing = roundsBySession.get(row.session_id) ?? [];
      existing.push({
        round: row.round,
        answer: row.answer,
        score: row.score,
        reaction_time_ms: row.reaction_time_ms,
      });
      roundsBySession.set(row.session_id, existing);
    }
  }

  // ── Build items ──────────────────────────────────────────────────────────
  const items: HistoryItem[] = rows.map((row) => {
    const item: HistoryItem = {
      session_id: row.session_id,
      challenge_id: row.challenge_id,
      challenge_title: row.challenge_title,
      started_at: row.started_at,
      completed_at: row.completed_at,
      total_score: row.total_score,
      outcome: row.outcome,
      payout_amount_usdc: row.payout_amount_usdc,
    };

    if (includeRounds) {
      item.rounds = roundsBySession.get(row.session_id) ?? [];
    }

    return item;
  });

  // ── Next cursor ──────────────────────────────────────────────────────────
  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      completed_at: last.completed_at,
      id: last.session_id,
    });
  }

  return { items, nextCursor };
}

export async function getArchivedLeaderboard(
  challengeId: string,
  limit = 20,
  cursor?: string
): Promise<{
  sessions: Array<GameSession & { username: string; avatar_url: string }>;
  nextCursor: string | null;
}> {
  const cursorValues = decodeCursorSafe(cursor, ["total_score", "challenge_ended_at", "id"]);

  let whereExtra = "";
  const params: unknown[] = [challengeId];

  if (cursorValues) {
    const score = cursorValues.total_score;
    const endedAt = cursorValues.challenge_ended_at;
    const id = cursorValues.id as string;
    whereExtra = `AND (gs.total_score < $${params.length + 1} OR (gs.total_score = $${params.length + 1} AND (gs.challenge_ended_at > $${params.length + 2} OR (gs.challenge_ended_at = $${params.length + 2} AND gs.id > $${params.length + 3}))))`;
    params.push(score, endedAt, id);
  }

  params.push(limit);

  const result = await query<GameSession & { username: string; avatar_url: string }>(
    `SELECT gs.*, u.username as username, u.avatar_url
     FROM game_sessions_archive gs
     JOIN users u ON gs.user_id = u.id
     WHERE gs.challenge_id = $1
       AND gs.flagged = FALSE
       AND gs.is_practice = FALSE
       AND gs.status = 'completed'
       AND u.deleted_at IS NULL
     ${whereExtra}
     ORDER BY gs.total_score DESC, gs.challenge_ended_at ASC, gs.id ASC
     LIMIT $${params.length}`,
    params
  );

  const sessions = result.rows;
  const nextCursor: string | null =
    sessions.length === limit
      ? encodeCursor({
          total_score: sessions[sessions.length - 1].total_score,
          challenge_ended_at: sessions[sessions.length - 1].challenge_ended_at,
          id: sessions[sessions.length - 1].id,
        })
      : null;

  return { sessions, nextCursor };
}
