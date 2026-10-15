# Shivajinagar-Voting

Calling desk for the 209 Chhatrapati Shivajinagar graduate & teacher voter lists. Volunteers log in, call voters pin code by pin code, and tap the outcome. The Adhyaksh dashboard shows live progress.

Under the guidance of **Siddharth Shirole** (MLA, Chhatrapati Shivajinagar), **Sapna Chhajed** (Corporator, Pune Municipal Corporation) and **Anand Chhajed** (Uttar Mandal Adhyaksh).
Candidates: **Smita Jadhav** (Pune Graduate constituency) and **Kaustubh Gawade** (Pune Teachers constituency).

Developed by **Sai Randive** (Sarchitnis, BJYM, Ch. Shivajinagar Uttar Mandal).

## How it works

- `public/index.html`: the whole app, one mobile-first page.
  - **Caller login:** name plus the shared password.
  - **Adhyaksh login:** the admin password.
- `netlify/functions/api.mjs`: the API at `/api/*`, built on Neon Postgres through `@neondatabase/serverless`.
- **Database tables (Neon project "Shivajinagar Voting"):**
  - `raw_graduate_list`, `raw_teacher_list`: every Excel row, unchanged.
  - `voters`: both lists merged (2,561 voters). The 68 people who appear in both lists are one record marked "dual voter".
  - `call_logs`: every call. `voter_status` holds the latest outcome per voter.

### Calling order ("Smart priority")

Every pin code is treated equally. Pick any pin code from the dropdown. Within it, voters are sorted like this:

1. Voters with a mobile number come first.
2. Then by voter type:
   - ★ Dual voters (on both the graduate and the teacher list)
   - Opinion leaders (teachers, doctors, industrialists, police officers, scientists, lawyers)
   - Professionals and post-graduates
   - General
3. Then voters with fewer call attempts.
4. Then by part and serial number.

### Tabs

- **To call:** has a mobile number and hasn't been called yet.
- **Call back:** last outcome was no answer or call back.
- **Done:** last outcome was supportive, neutral, opposed or wrong number.
- **No phone:** no mobile number, so meet them in person (school or address shown).

## Deploy on Netlify

1. In Netlify, import this GitHub repo. The build settings come from `netlify.toml`.
2. Under Site settings → Environment variables, add:
   - `DATABASE_URL`: the Neon pooled connection string (from `.env.local`)
   - `APP_PASSWORD`: the caller password
   - `ADMIN_PASSWORD`: the Adhyaksh password
   - `AUTH_SECRET`: any long random string
3. Deploy.

## Local development

```bash
npm install
npm start            # http://localhost:8888, reads .env.local
npm run build        # build check used by Netlify
```

## Reloading voter data

The Excel files aren't in git because they contain personal data. Put them in the project root and run:

```bash
npm run prepare-data   # Excel -> data/voters.json
npm run seed           # upsert into Neon; call history is kept
```
