// Load data/voters.json (from scripts/prepare_data.py) into Neon.
// Re-runnable: voter rows are upserted, call history is never touched.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { SCHEMA } from '../lib/schema.mjs';
import { loadEnv } from './env.mjs';

loadEnv();
const sql = neon(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
const { voters, raw_graduate, raw_teacher } = JSON.parse(readFileSync(new URL('../data/voters.json', import.meta.url), 'utf8'));

for (const stmt of SCHEMA) await sql.query(stmt);

async function chunked(rows, size, fn) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

for (const [table, rows] of [['raw_graduate_list', raw_graduate], ['raw_teacher_list', raw_teacher]]) {
  await chunked(rows.map((d, i) => ({ i, d })), 500, (batch) =>
    sql.query(
      `INSERT INTO ${table} (row_no, data)
       SELECT * FROM unnest($1::int[], $2::jsonb[])
       ON CONFLICT (row_no) DO UPDATE SET data = EXCLUDED.data`,
      [batch.map((r) => r.i), batch.map((r) => JSON.stringify(r.d))]
    ));
}

const COLS = ['id', 'source', 'part', 'serial', 'name_en', 'name_mr', 'relative', 'address', 'pin', 'education',
  'occupation', 'institution', 'age', 'gender', 'id_card', 'mobile', 'remark', 'teacher_part', 'teacher_serial',
  'tier', 'raw_row'];
const INT = new Set(['part', 'serial', 'age', 'teacher_part', 'teacher_serial', 'tier', 'raw_row']);
await chunked(voters, 400, (batch) =>
  sql.query(
    `INSERT INTO voters (${COLS.join(',')})
     SELECT * FROM unnest(${COLS.map((c, i) => `$${i + 1}::${INT.has(c) ? 'int' : 'text'}[]`).join(',')})
     ON CONFLICT (id) DO UPDATE SET ${COLS.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    COLS.map((c) => batch.map((v) => v[c] ?? null))
  ));

const [counts] = await sql`SELECT
  (SELECT count(*) FROM raw_graduate_list)::int AS raw_graduate,
  (SELECT count(*) FROM raw_teacher_list)::int AS raw_teacher,
  (SELECT count(*) FROM voters)::int AS voters,
  (SELECT count(*) FROM voters WHERE mobile IS NOT NULL)::int AS with_mobile,
  (SELECT count(DISTINCT pin) FROM voters)::int AS pins`;
console.log('Seeded:', counts);
