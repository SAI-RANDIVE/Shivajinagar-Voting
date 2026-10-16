// Single Netlify Function serving /api/*. Uses Neon's serverless (HTTP) driver,
// the recommended driver for Netlify's short-lived functions.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { FINAL, STATUSES } from '../../lib/schema.mjs';

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const CLAIM_MINUTES = 30; // how long a tapped Call keeps the voter locked to that caller
const SAVE_WINDOW_MINUTES = 180; // the caller can still save the result this long after tapping Call
const CORRECTION_MINUTES = 10; // a caller may fix their own outcome for this long
// Minimum seconds between tapping Call and saving an outcome, so nothing is ticked without calling.
const MIN_SECONDS = { S: 10, N: 10, O: 10, CB: 5, NA: 5, WN: 3 };

let sqlClient;
const db = () => (sqlClient ??= neon(process.env.DATABASE_URL));

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const secret = () => process.env.AUTH_SECRET || `${process.env.APP_PASSWORD}|${process.env.ADMIN_PASSWORD}`;
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url');

function same(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

function issueToken(sid, role, name) {
  const body = b64(JSON.stringify({ sid, role, name, exp: Date.now() + TOKEN_TTL_MS }));
  return `${body}.${sign(body)}`;
}

function readToken(req) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [body, sig] = tok.split('.');
  if (!body || !sig || !same(sig, sign(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() && p.sid ? p : null;
  } catch {
    return null;
  }
}

const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

async function login(req) {
  const missing = ['APP_PASSWORD', 'ADMIN_PASSWORD', 'DATABASE_URL'].filter((k) => !process.env[k]);
  if (missing.length) {
    return json({ error: `Server setup incomplete: add ${missing.join(', ')} in Netlify → Site configuration → Environment variables, then redeploy` }, 503);
  }
  const body = await req.json().catch(() => ({}));
  const password = String(body.password ?? '').trim();
  let role, name;
  if (same(password, process.env.ADMIN_PASSWORD)) {
    role = 'admin';
    name = cleanName(body.name) || 'Adhyaksh';
  } else if (same(password, process.env.APP_PASSWORD)) {
    role = 'caller';
    name = cleanName(body.name);
    if (!name) return json({ error: 'Please enter your name' }, 400);
  } else {
    return json({ error: 'Wrong password' }, 401);
  }
  const sid = randomUUID();
  const ua = (req.headers.get('user-agent') || '').slice(0, 300);
  await db()`INSERT INTO sessions (id, name, role, user_agent) VALUES (${sid}, ${name}, ${role}, ${ua})`;
  return json({ token: issueToken(sid, role, name), role, name });
}

// Every authenticated request proves the session is still open and records activity.
async function touchSession(user) {
  const rows = await db()`
    UPDATE sessions SET last_seen = now() WHERE id = ${user.sid} AND ended_at IS NULL RETURNING id`;
  return rows.length > 0;
}

async function logout(user) {
  await db()`UPDATE sessions SET ended_at = now(), last_seen = now() WHERE id = ${user.sid} AND ended_at IS NULL`;
  await db()`DELETE FROM claims WHERE session_id = ${user.sid}`;
  return json({ ok: true });
}

async function voters() {
  const rows = await db()`
    SELECT id, source, part, serial, name_en, name_mr, relative, address, pin, education, occupation,
           institution, age, gender, coalesce(mobile, mobile_added) AS mobile, (mobile IS NULL AND mobile_added IS NOT NULL) AS added,
           remark, tier, possible_dup
    FROM voters ORDER BY tier, pin NULLS LAST, part, serial`;
  return json({ voters: rows });
}

async function statuses() {
  const sql = db();
  const [st, cl] = await sql.transaction([
    sql`SELECT voter_id, status, caller, note, attempts, updated_at FROM voter_status`,
    sql`SELECT voter_id, caller, dialed_at, expires_at FROM claims
        WHERE expires_at > now() OR dialed_at > now() - make_interval(mins => ${SAVE_WINDOW_MINUTES})`,
  ]);
  return json({ statuses: st, claims: cl, now: new Date().toISOString() });
}

async function currentState(voterId) {
  const sql = db();
  const [[status], [claim]] = await sql.transaction([
    sql`SELECT status, caller, updated_at FROM voter_status WHERE voter_id = ${voterId}`,
    sql`SELECT caller, session_id, dialed_at, expires_at, expires_at > now() AS active,
               extract(epoch FROM now() - dialed_at)::int AS seconds,
               dialed_at > now() - make_interval(mins => ${SAVE_WINDOW_MINUTES}) AS saveable
        FROM claims WHERE voter_id = ${voterId}`,
  ]);
  return { status, claim };
}

// Tapping Call / WhatsApp claims the voter for this caller.
async function dial(req, user) {
  const { voter_id, method } = await req.json().catch(() => ({}));
  if (!voter_id) return json({ error: 'Missing voter' }, 400);
  const how = ['tel', 'wa', 'other'].includes(method) ? method : 'tel';
  const { status, claim } = await currentState(voter_id);
  if (status && FINAL.includes(status.status) && status.caller !== user.name && user.role !== 'admin') {
    return json({ error: `Already completed by ${status.caller}` }, 409);
  }
  if (claim?.active && claim.caller !== user.name) {
    return json({ error: `${claim.caller} is calling this voter right now` }, 409);
  }
  const sql = db();
  const [row] = await sql`
    INSERT INTO claims (voter_id, caller, session_id, dialed_at, expires_at)
    VALUES (${voter_id}, ${user.name}, ${user.sid}, now(), now() + make_interval(mins => ${CLAIM_MINUTES}))
    ON CONFLICT (voter_id) DO UPDATE SET caller = EXCLUDED.caller, session_id = EXCLUDED.session_id,
      dialed_at = EXCLUDED.dialed_at, expires_at = EXCLUDED.expires_at
    WHERE claims.expires_at <= now() OR claims.caller = EXCLUDED.caller
    RETURNING voter_id, caller, dialed_at, expires_at`;
  if (!row) return json({ error: 'Someone else just started calling this voter' }, 409);
  await sql`INSERT INTO dials (voter_id, caller, session_id, method, created_at)
            VALUES (${voter_id}, ${user.name}, ${user.sid}, ${how}, ${row.dialed_at})`;
  return json({ claim: row });
}

async function recordCall(req, user) {
  const { voter_id, status, note } = await req.json().catch(() => ({}));
  if (!voter_id || !STATUSES.includes(status)) return json({ error: 'Invalid call outcome' }, 400);
  const n = note ? String(note).trim().slice(0, 500) || null : null;
  const sql = db();
  const { status: prev, claim } = await currentState(voter_id);

  if (prev && FINAL.includes(prev.status) && prev.caller !== user.name && user.role !== 'admin') {
    return json({ error: `Already completed by ${prev.caller}` }, 409);
  }

  const ownClaim = claim && claim.caller === user.name && claim.saveable;
  if (!ownClaim) {
    // No fresh Call tap: only allow fixing your own outcome from the last few minutes.
    const [last] = await sql`
      SELECT id FROM call_logs WHERE voter_id = ${voter_id} AND caller = ${user.name}
        AND created_at > now() - make_interval(mins => ${CORRECTION_MINUTES})
      ORDER BY created_at DESC LIMIT 1`;
    if (claim?.active && claim.caller !== user.name) return json({ error: `${claim.caller} is calling this voter right now` }, 409);
    if (!last) return json({ error: 'Tap the Call button first, then save the outcome after the call' }, 409);
    const [, [row]] = await sql.transaction([
      sql`UPDATE call_logs SET status = ${status}, note = coalesce(${n}, note) WHERE id = ${last.id}`,
      sql`UPDATE voter_status SET status = ${status}, note = coalesce(${n}, note), updated_at = now()
          WHERE voter_id = ${voter_id} RETURNING voter_id, status, caller, note, attempts, updated_at`,
    ]);
    return json({ status: row, corrected: true });
  }

  const wait = MIN_SECONDS[status] - claim.seconds;
  if (wait > 0) return json({ error: `Finish the call first — you can save this in ${wait} s` }, 409);

  const [, [row]] = await sql.transaction([
    sql`INSERT INTO call_logs (voter_id, caller, status, note, dialed_at, session_id)
        VALUES (${voter_id}, ${user.name}, ${status}, ${n}, ${claim.dialed_at}, ${user.sid})`,
    sql`INSERT INTO voter_status (voter_id, status, caller, note)
        VALUES (${voter_id}, ${status}, ${user.name}, ${n})
        ON CONFLICT (voter_id) DO UPDATE SET status = EXCLUDED.status, caller = EXCLUDED.caller,
          note = coalesce(EXCLUDED.note, voter_status.note), attempts = voter_status.attempts + 1, updated_at = now()
        RETURNING voter_id, status, caller, note, attempts, updated_at`,
    sql`DELETE FROM claims WHERE voter_id = ${voter_id}`,
  ]);
  return json({ status: row });
}

async function release(req, user) {
  const { voter_id } = await req.json().catch(() => ({}));
  await db()`DELETE FROM claims WHERE voter_id = ${voter_id} AND caller = ${user.name}`;
  return json({ ok: true });
}

async function addMobile(req, user) {
  const { voter_id, mobile } = await req.json().catch(() => ({}));
  const m = String(mobile ?? '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(m)) return json({ error: 'Enter a valid 10-digit mobile number' }, 400);
  const [row] = await db()`
    UPDATE voters SET mobile_added = ${m}, mobile_added_by = ${user.name}, mobile_added_at = now()
    WHERE id = ${voter_id} AND mobile IS NULL RETURNING id, mobile_added AS mobile`;
  if (!row) return json({ error: 'This voter already has a number' }, 409);
  return json({ voter: row });
}

const IST_TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

async function stats() {
  const sql = db();
  const [totals, byStatus, byPin, byCaller, daily, hourly, byTier, online, byCons] = await sql.transaction([
    sql`SELECT count(*)::int AS voters,
               count(*) FILTER (WHERE coalesce(v.mobile, v.mobile_added) IS NOT NULL)::int AS with_mobile,
               count(s.voter_id)::int AS called,
               count(*) FILTER (WHERE s.status IN ('S','N','O','CB'))::int AS reached,
               (SELECT count(*) FROM call_logs)::int AS total_calls,
               (SELECT count(*) FROM dials)::int AS total_dials,
               (SELECT count(*) FROM dials WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${sql.unsafe(IST_TODAY)})::int AS dials_today,
               (SELECT count(*) FROM call_logs WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${sql.unsafe(IST_TODAY)})::int AS calls_today,
               (SELECT count(DISTINCT caller) FROM call_logs)::int AS callers,
               (SELECT count(*) FROM claims WHERE expires_at > now())::int AS calling_now,
               (SELECT count(*) FROM voters WHERE mobile_added IS NOT NULL)::int AS numbers_added
        FROM voters v LEFT JOIN voter_status s ON s.voter_id = v.id`,
    sql`SELECT status, count(*)::int AS n FROM voter_status GROUP BY status`,
    sql`SELECT coalesce(v.pin, 'No pin') AS pin, count(*)::int AS total,
               count(*) FILTER (WHERE coalesce(v.mobile, v.mobile_added) IS NOT NULL)::int AS with_mobile,
               count(s.voter_id)::int AS called,
               count(*) FILTER (WHERE s.status = 'S')::int AS s,
               count(*) FILTER (WHERE s.status = 'N')::int AS n,
               count(*) FILTER (WHERE s.status = 'O')::int AS o,
               count(*) FILTER (WHERE s.status IN ('NA','CB'))::int AS pending
        FROM voters v LEFT JOIN voter_status s ON s.voter_id = v.id
        GROUP BY 1 ORDER BY total DESC`,
    sql`WITH c AS (
          SELECT caller, count(*)::int AS calls, count(DISTINCT voter_id)::int AS voters,
                 count(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${sql.unsafe(IST_TODAY)})::int AS today,
                 count(*) FILTER (WHERE status = 'S')::int AS s, count(*) FILTER (WHERE status = 'N')::int AS n,
                 count(*) FILTER (WHERE status = 'O')::int AS o, count(*) FILTER (WHERE status = 'NA')::int AS na,
                 count(*) FILTER (WHERE status = 'CB')::int AS cb, count(*) FILTER (WHERE status = 'WN')::int AS wn,
                 round(avg(extract(epoch FROM created_at - dialed_at)) FILTER (WHERE status IN ('S','N','O')))::int AS avg_secs,
                 min(created_at) AS first_call, max(created_at) AS last_call
          FROM call_logs GROUP BY caller),
        d AS (
          SELECT caller, count(*)::int AS dials,
                 count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM call_logs x WHERE x.voter_id = dd.voter_id
                   AND x.caller = dd.caller AND x.dialed_at = dd.created_at))::int AS unsaved,
                 max(created_at) AS last_dial
          FROM dials dd GROUP BY caller),
        s AS (
          SELECT name, count(*)::int AS logins,
                 sum(extract(epoch FROM coalesce(ended_at, last_seen) - login_at))::int AS online_secs,
                 max(last_seen) AS last_seen
          FROM sessions GROUP BY name)
        SELECT coalesce(c.caller, d.caller, s.name) AS caller, coalesce(c.calls, 0) AS calls, coalesce(c.voters, 0) AS voters,
               coalesce(d.dials, 0) AS dials, coalesce(d.unsaved, 0) AS unsaved, d.last_dial,
               coalesce(c.today, 0) AS today, coalesce(c.s, 0) AS s, coalesce(c.n, 0) AS n, coalesce(c.o, 0) AS o,
               coalesce(c.na, 0) AS na, coalesce(c.cb, 0) AS cb, coalesce(c.wn, 0) AS wn, c.avg_secs,
               c.first_call, c.last_call, coalesce(s.logins, 0) AS logins, coalesce(s.online_secs, 0) AS online_secs,
               s.last_seen, s.last_seen > now() - interval '2 minutes' AS online
        FROM c FULL JOIN d ON d.caller = c.caller FULL JOIN s ON s.name = coalesce(c.caller, d.caller)
        ORDER BY calls DESC, dials DESC, online_secs DESC`,
    sql`SELECT d::date AS day, count(c.id)::int AS n
        FROM generate_series(${sql.unsafe(IST_TODAY)} - 13, ${sql.unsafe(IST_TODAY)}, '1 day') d
        LEFT JOIN call_logs c ON (c.created_at AT TIME ZONE 'Asia/Kolkata')::date = d::date
        GROUP BY 1 ORDER BY 1`,
    sql`SELECT h AS hour, count(c.id)::int AS n
        FROM generate_series(0, 23) h
        LEFT JOIN call_logs c ON (c.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${sql.unsafe(IST_TODAY)}
          AND extract(hour FROM c.created_at AT TIME ZONE 'Asia/Kolkata') = h
        GROUP BY 1 ORDER BY 1`,
    sql`SELECT v.tier, count(*)::int AS total, count(s.voter_id)::int AS called,
               count(*) FILTER (WHERE s.status = 'S')::int AS s
        FROM voters v LEFT JOIN voter_status s ON s.voter_id = v.id GROUP BY 1 ORDER BY 1`,
    sql`SELECT count(*)::int AS n FROM sessions WHERE ended_at IS NULL AND last_seen > now() - interval '2 minutes'`,
    sql`SELECT k AS cons, count(*)::int AS total,
               count(*) FILTER (WHERE coalesce(v.mobile, v.mobile_added) IS NOT NULL)::int AS with_mobile,
               count(s.voter_id)::int AS called, count(*) FILTER (WHERE s.status = 'S')::int AS s,
               count(*) FILTER (WHERE s.status = 'O')::int AS o
        FROM voters v CROSS JOIN LATERAL (VALUES ('graduate'), ('teacher')) x(k)
        LEFT JOIN voter_status s ON s.voter_id = v.id
        WHERE v.source = 'both' OR v.source = k GROUP BY k`,
  ]);
  return json({ totals: { ...totals[0], online: online[0].n }, byStatus, byPin, byCaller, daily, hourly, byTier, byCons });
}

async function sessionsList() {
  const rows = await db()`
    SELECT s.id, s.name, s.role, s.user_agent, s.login_at, s.last_seen, s.ended_at,
           s.ended_at IS NULL AND s.last_seen > now() - interval '2 minutes' AS online,
           extract(epoch FROM coalesce(s.ended_at, s.last_seen) - s.login_at)::int AS secs,
           (SELECT count(*) FROM call_logs c WHERE c.session_id = s.id)::int AS calls
    FROM sessions s ORDER BY s.login_at DESC LIMIT 300`;
  return json({ sessions: rows });
}

async function callLog(url) {
  const p = url.searchParams;
  const caller = p.get('caller') || null;
  const status = p.get('status') || null;
  const range = p.get('range') || 'all';
  const days = { today: 0, yesterday: 1, '7d': 6 }[range];
  const offset = Math.max(0, Number(p.get('offset')) || 0);
  const sql = db();
  // Saved calls plus Call taps that never got a result (status 'DIAL').
  const events = sql`
    SELECT x.created_at, x.dialed_at, extract(epoch FROM x.created_at - x.dialed_at)::int AS secs,
           x.caller, x.status, x.note, x.voter_id FROM call_logs x
    UNION ALL
    SELECT dd.created_at, dd.created_at, NULL, dd.caller, 'DIAL', dd.method, dd.voter_id FROM dials dd
    WHERE NOT EXISTS (SELECT 1 FROM call_logs x WHERE x.voter_id = dd.voter_id AND x.caller = dd.caller
                        AND x.dialed_at = dd.created_at)`;
  const where = sql`
    (${caller}::text IS NULL OR c.caller = ${caller})
    AND (${status}::text IS NULL OR c.status = ${status})
    AND (${days ?? null}::int IS NULL OR (c.created_at AT TIME ZONE 'Asia/Kolkata')::date
         BETWEEN ${sql.unsafe(IST_TODAY)} - ${days ?? 0}::int AND ${sql.unsafe(IST_TODAY)} - ${range === 'yesterday' ? 1 : 0}::int)`;
  const [rows, [{ total }]] = await sql.transaction([
    sql`SELECT c.created_at, c.dialed_at, c.secs, c.caller, c.status, c.note, v.id AS voter_id, v.name_en, v.name_mr,
               coalesce(v.mobile, v.mobile_added) AS mobile, v.pin, v.source
        FROM (${events}) c JOIN voters v ON v.id = c.voter_id
        WHERE ${where} ORDER BY c.created_at DESC LIMIT 100 OFFSET ${offset}`,
    sql`SELECT count(*)::int AS total FROM (${events}) c WHERE ${where}`,
  ]);
  return json({ rows, total });
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function exportCsv() {
  const rows = await db()`
    SELECT CASE v.source WHEN 'both' THEN 'Graduate + Teacher' WHEN 'teacher' THEN 'Teacher' ELSE 'Graduate' END AS constituency,
           v.pin, v.part, v.serial, v.name_en, v.name_mr, v.age, v.gender, coalesce(v.mobile, v.mobile_added) AS mobile,
           v.mobile_added_by, v.education, v.occupation, v.institution, v.tier, v.address, s.status, s.caller, s.attempts, s.note,
           to_char(s.updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS last_call
    FROM voters v LEFT JOIN voter_status s ON s.voter_id = v.id
    ORDER BY v.pin NULLS LAST, v.part, v.serial`;
  const cols = Object.keys(rows[0] ?? { pin: 1 });
  const body = '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="chhatrapati-shivajinagar-calling-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, '');
  const post = req.method === 'POST';
  try {
    if (path === 'health') {
      const [r] = await db()`SELECT count(*)::int AS voters FROM voters`;
      return json({ ok: true, ...r });
    }
    if (path === 'login' && post) return await login(req);

    const user = readToken(req);
    if (!user || !(await touchSession(user))) return json({ error: 'Please log in again' }, 401);

    if (path === 'logout' && post) return await logout(user);
    if (path === 'voters') return await voters();
    if (path === 'status') return await statuses();
    if (path === 'dial' && post) return await dial(req, user);
    if (path === 'call' && post) return await recordCall(req, user);
    if (path === 'release' && post) return await release(req, user);
    if (path === 'mobile' && post) return await addMobile(req, user);

    if (user.role !== 'admin') return json({ error: 'Adhyaksh access only' }, 403);
    if (path === 'stats') return await stats();
    if (path === 'sessions') return await sessionsList();
    if (path === 'calls') return await callLog(url);
    if (path === 'export') return await exportCsv();
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: 'Server error' }, 500);
  }
};

export const config = { path: '/api/*' };
