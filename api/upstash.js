// Lightweight Upstash helper — best-effort. No secrets here.
// If you set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in env, this will LPUSH the JSON record
// under key `resume:history:<nickname>` using the Upstash REST `/commands` endpoint.
//
// IMPORTANT: verify the correct Upstash REST path for your DB. If your Upstash URL already includes
// a path, adapt accordingly. This file is intentionally minimal — adjust if your Upstash account requires different routes.

const fetch = require("node-fetch");

/**
 * Save history record (best-effort). Expects env:
 * - UPSTASH_REDIS_REST_URL (e.g. https://xxx.upstash.io)
 * - UPSTASH_REDIS_REST_TOKEN (Bearer token)
 */
async function saveHistory(record) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) {
    // No Upstash configured — no-op
    return;
  }

  // Key per user
  const key = `resume:history:${record.nickname || "anon"}`;
  const payload = {
    command: ["LPUSH", key, JSON.stringify(record)],
    // optional: trim list to keep last N items (use LTRIM)
  };

  // POST to Upstash REST "commands" endpoint. Some Upstash URLs require /commands path.
  const url = base.replace(/\/$/, "") + "/commands";

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Upstash error ${resp.status}: ${txt}`);
  }

  // Optionally run a LTRIM to cap list length (e.g., keep last 20)
  try {
    const trimPayload = { command: ["LTRIM", key, "0", "19"] };
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(trimPayload),
    });
  } catch (e) {
    // ignore trimming errors
  }
}

module.exports = { saveHistory };