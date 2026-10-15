// Single Netlify Function serving /api/*. Uses Neon's serverless (HTTP) driver,
// the recommended driver for Netlify's short-lived functions.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { STATUSES } from '../../lib/schema.mjs';

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
let sqlClient;
const db = () => (sqlClient ??= neon(process.env.DATABASE_URL));

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

function secret() {
  const s = process.env.AUTH_SECRET || `${process.env.APP_PASSWORD}|${process.env.ADMIN_PASSWORD}`;
  if (!process.env.APP_PASSWORD || !process.env.ADMIN_PASSWORD) throw new Error('APP_PASSWORD / ADMIN_PASSWORD not set');
  return s;
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url');

function same(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

function issueToken(role, name) {
  const body = b64(JSON.stringify({ role, name, exp: Date.now() + TOKEN_TTL_MS }));
  return `${body}.${sign(body)}`;
}

function readToken(req) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [body, sig] = tok.split('.');
  if (!body || !sig || !same(sig, sign(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
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
  const name = body.name;
  if (same(password, process.env.ADMIN_PASSWORD)) {
    const n = cleanName(name) || 'Adhyaksh';
    return json({ token: issueToken('admin', n), role: 'admin', name: n });
  }
  if (same(password, process.env.APP_PASSWORD)) {
    const n = cleanName(name);
    if (!n) return json({ error: 'Please enter your name' }, 400);
    return json({ token: issueToken('caller', n), role: 'caller', name: n });
  }
  return json({ error: 'Wrong password' }, 401);
}

async function voters() {
  const rows = await db()`
    SELECT id, source, part, serial, name_en, name_mr, relative, address, pin, education, occupation,
           institution, age, gender, mobile, remark, tier
    FROM voters ORDER BY tier, pin NULLS LAST, part, serial`;
  return json({ voters: rows }, 200, { 'cache-control': 'private, max-age=300' });
}

async function statuses() {
  const rows = await db()`
    SELECT voter_id, status, caller, note, attempts, updated_at FROM voter_status`;
  return json({ statuses: rows, now: new Date().toISOString() });
}

async function recordCall(req, user) {
  const { voter_id, status, note } = await req.json().catch(() => ({}));
  if (!voter_id || !STATUSES.includes(status)) return json({ error: 'Invalid call outcome' }, 400);
  const n = note ? String(note).trim().slice(0, 500) || null : null;
  const sql = db();
  const [, [row]] = await sql.transaction([
    sql`INSERT INTO call_logs (voter_id, caller, status, note) VALUES (${voter_id}, ${user.name}, ${status}, ${n})`,
    sql`INSERT INTO voter_status (voter_id, status, caller, note)
        VALUES (${voter_id}, ${status}, ${user.name}, ${n})
        ON CONFLICT (voter_id) DO UPDATE SET status = EXCLUDED.status, caller = EXCLUDED.caller,
          note = COALESCE(EXCLUDED.note, voter_status.note), attempts = voter_status.attempts + 1, updated_at = now()
        RETURNING voter_id, status, caller, note, attempts, updated_at`,
  ]);
  return json({ status: row });
}

async function stats() {
  const sql = db();
  const [totals, byStatus, byPin, byCaller, daily, recent, byTier] = await sql.transaction([
    sql`SELECT count(*)::int AS voters,
               count(*) FILTER (WHERE v.mobile IS NOT NULL)::int AS with_mobile,
               count(s.voter_id)::int AS called,
               count(*) FILTER (WHERE s.status NOT IN ('NA','WN'))::int AS reached,
               (SELECT count(*) FROM call_logs)::int AS total_calls,
               (SELECT count(*) FROM call_logs
                 WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS calls_today,
               (SELECT count(DISTINCT caller) FROM call_logs)::int AS callers
        FROM voters v LEFT JOIN voter_status s ON s.voter_id = v.id`,
    sql`SELECT status, count(*)::int AS n FROM voter_status GROUP BY status`,
    sql`SELECT coalesce(v.pin, 'No pin') AS pin, count(*)::int AS total,
               count(*) FILTER (WHERE v.mobile IS NOT NULL)::int AS with_mobile,
               count(s.voter_id)::int AS called,
               count(*) FILTER (WHERE s.status = 'S')::int AS s,
               count(*) FILTER (WHERE s.status = 'N')::int AS n,
               count(*) FILTER (WHERE s.status = 'O')::int AS o,
               count(*) FILTER (WHERE s.status IN ('NA','CB'))::int AS pending
        FROM voters v LEFT JOIN voter_status s ON s.voter_id = v.id
        GROUP BY 1 ORDER BY total DESC`,
    sql`SELECT caller, count(*)::int AS calls, count(DISTINCT voter_id)::int AS voters,
               count(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today,
               count(*) FILTER (WHERE status = 'S')::int AS s,
               max(created_at) AS last_call
        FROM call_logs GROUP BY caller ORDER BY calls DESC`,
    sql`SELECT d::date AS day, count(c.id)::int AS n
        FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 13, (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day') d
        LEFT JOIN call_logs c ON (c.created_at AT TIME ZONE 'Asia/Kolkata')::date = d::date
        GROUP BY 1 ORDER BY 1`,
    sql`SELECT c.created_at, c.caller, c.status, c.note, v.name_en, v.name_mr, v.pin
        FROM call_logs c JOIN voters v ON v.id = c.voter_id ORDER BY c.created_at DESC LIMIT 40`,
    sql`SELECT v.tier, count(*)::int AS total, count(s.voter_id)::int AS called,
               count(*) FILTER (WHERE s.status = 'S')::int AS s
        FROM voters v LEFT JOIN voter_status s ON s.voter_id = v.id GROUP BY 1 ORDER BY 1`,
  ]);
  return json({ totals: totals[0], byStatus, byPin, byCaller, daily, recent, byTier });
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function exportCsv() {
  const rows = await db()`
    SELECT v.pin, v.part, v.serial, v.name_en, v.name_mr, v.age, v.gender, v.mobile, v.education, v.occupation,
           v.institution, v.source, v.tier, v.address, s.status, s.caller, s.attempts, s.note,
           to_char(s.updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS last_call
    FROM voters v LEFT JOIN voter_status s ON s.voter_id = v.id
    ORDER BY v.pin NULLS LAST, v.part, v.serial`;
  const cols = Object.keys(rows[0] ?? { pin: 1 });
  const body = '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="shivajinagar-calling-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, '');
  try {
    if (path === 'health') {
      const [r] = await db()`SELECT count(*)::int AS voters FROM voters`;
      return json({ ok: true, ...r });
    }
    if (path === 'login' && req.method === 'POST') return await login(req);

    const user = readToken(req);
    if (!user) return json({ error: 'Please log in again' }, 401);

    if (path === 'voters' && req.method === 'GET') return await voters();
    if (path === 'status' && req.method === 'GET') return await statuses();
    if (path === 'call' && req.method === 'POST') return await recordCall(req, user);

    if (user.role !== 'admin') return json({ error: 'Adhyaksh access only' }, 403);
    if (path === 'stats' && req.method === 'GET') return await stats();
    if (path === 'export' && req.method === 'GET') return await exportCsv();
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: 'Server error' }, 500);
  }
};

export const config = { path: '/api/*' };
