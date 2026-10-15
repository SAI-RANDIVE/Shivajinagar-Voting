// Build check for Netlify: the site is static, so this verifies the pieces exist and the function loads.
import { existsSync, readFileSync } from 'node:fs';

const required = ['public/index.html', 'public/img/siddharth-shirole.jpg', 'netlify/functions/api.mjs', 'lib/schema.mjs'];
const missing = required.filter((f) => !existsSync(f));
if (missing.length) throw new Error(`Missing files: ${missing.join(', ')}`);

const mod = await import('../netlify/functions/api.mjs');
if (typeof mod.default !== 'function' || mod.config?.path !== '/api/*') throw new Error('API function export is wrong');

const html = readFileSync('public/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
new Function(script); // throws on a syntax error in the page script
if (!html.includes('Developed by <b>Sai Randive</b>')) throw new Error('Credit line missing');
console.log('Build OK:', required.length, 'files checked, API function and page script parse');
