import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export async function initDatabase() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      primary_language TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS translation_groups (
      group_id TEXT PRIMARY KEY,
      source_message_id TEXT UNIQUE NOT NULL,
      source_channel_id TEXT NOT NULL,
      source_language TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_avatar TEXT,
      original_content TEXT DEFAULT '',
      attachment_urls JSONB DEFAULT '[]'::jsonb,
      reply_to_group_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS translation_messages (
      message_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES translation_groups(group_id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      language_key TEXT NOT NULL,
      is_source BOOLEAN DEFAULT FALSE,
      base_content TEXT DEFAULT '',
      webhook_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, language_key)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_translation_messages_group
      ON translation_messages(group_id)`,

    `CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES translation_groups(group_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      emoji_key TEXT NOT NULL,
      PRIMARY KEY(message_id, user_id, emoji_key)
    )`,

    `CREATE TABLE IF NOT EXISTS keyword_alert_deliveries_v2 (
      message_id TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS keyword_alert_deliveries (
      message_id TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS social_companions (
      original_message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      companion_message_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS highlights (
      source_message_id TEXT PRIMARY KEY,
      highlight_message_id TEXT NOT NULL,
      source_channel_id TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS tournament_state (
      tournament TEXT PRIMARY KEY,
      active_date TEXT,
      round INTEGER DEFAULT 0,
      phase TEXT DEFAULT 'inactive',
      vote_ends_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS sent_events (
      event_key TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS localized_ping_roles (
      source_role_id TEXT NOT NULL,
      language_key TEXT NOT NULL,
      scoped_role_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (source_role_id, language_key)
    )`,

    `CREATE TABLE IF NOT EXISTS guild_ping_staff_audit (
      id BIGSERIAL PRIMARY KEY,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      event_key TEXT,
      actor_id TEXT,
      delivered_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      languages JSONB NOT NULL DEFAULT '[]'::jsonb
    )`,

    `CREATE UNIQUE INDEX IF NOT EXISTS guild_ping_staff_audit_once
      ON guild_ping_staff_audit(kind, event_key)
      WHERE event_key IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS guild_ping_member_mirrors (
      source_message_id TEXT PRIMARY KEY,
      member_channel_id TEXT NOT NULL,
      mirrored_message_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS onboarding_sessions (
      user_id TEXT PRIMARY KEY,
      language TEXT,
      reminders JSONB DEFAULT '[]'::jsonb,
      playstyle TEXT,
      social TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }

  console.log("✅ Persistent Postgres database ready.");
}

export async function dbGetState(key) {
  const result = await pool.query(
    "SELECT value FROM bot_state WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value ?? null;
}

export async function dbSetState(key, value) {
  await pool.query(
    `INSERT INTO bot_state(key, value, updated_at)
     VALUES($1, $2::jsonb, NOW())
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

export async function saveOnboardingSession(userId, session) {
  await pool.query(
    `INSERT INTO onboarding_sessions(user_id, language, reminders, playstyle, social, updated_at)
     VALUES($1, $2, $3::jsonb, $4, $5, NOW())
     ON CONFLICT(user_id) DO UPDATE SET
       language = EXCLUDED.language,
       reminders = EXCLUDED.reminders,
       playstyle = EXCLUDED.playstyle,
       social = EXCLUDED.social,
       updated_at = NOW()`,
    [
      userId,
      session.language || null,
      JSON.stringify(session.reminders || []),
      session.playstyle || null,
      session.social || null
    ]
  );
  sessions.set(userId, {
    language: session.language || null,
    reminders: [...(session.reminders || [])],
    playstyle: session.playstyle || null,
    social: session.social || null
  });
}

export async function getOnboardingSession(userId) {
  if (sessions.has(userId)) return sessions.get(userId);

  const result = await pool.query(
    "SELECT language, reminders, playstyle, social FROM onboarding_sessions WHERE user_id = $1",
    [userId]
  );

  if (!result.rows[0]) return null;

  const row = result.rows[0];
  const session = {
    language: row.language || null,
    reminders: Array.isArray(row.reminders) ? row.reminders : [],
    playstyle: row.playstyle || null,
    social: row.social || null
  };

  sessions.set(userId, session);
  return session;
}

export async function deleteOnboardingSession(userId) {
  sessions.delete(userId);
  await pool.query(
    "DELETE FROM onboarding_sessions WHERE user_id = $1",
    [userId]
  );
}

const sessions = new Map();

export async function wasEventSent(key) {
  const result = await pool.query("SELECT 1 FROM sent_events WHERE event_key = $1", [key]);
  return !!result.rows[0];
}

export async function markEventSent(key) {
  await pool.query("INSERT INTO sent_events(event_key) VALUES($1) ON CONFLICT(event_key) DO NOTHING", [key]);
}
