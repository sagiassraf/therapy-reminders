// Operator commands against the deployed central web app (uses CENTRAL_URL + INTERNAL_TOKEN from .env).
//   npm run admin -- status                 properties that are set, appointment counts, clients
//   npm run admin -- log                    last 20 Log rows
//   npm run admin -- test                   send the sample reminder to TEST_PHONE
//   npm run admin -- set KEY=VALUE ...      update script properties (whitelisted on the server)
//   npm run admin -- push-token             copy WA_TOKEN from .env to the server
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
  .split(/\r?\n/).filter(l => /^\w+=/.test(l)).map(l => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]));

const [cmd, ...args] = process.argv.slice(2);
const body = { type: 'admin', token: env.INTERNAL_TOKEN };
if (cmd === 'status' || cmd === 'log') body.action = cmd;
else if (cmd === 'test') body.action = 'testSend';
else if (cmd === 'set') body.set = Object.fromEntries(args.map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
else if (cmd === 'push-token') body.set = { WA_TOKEN: env.WA_TOKEN };
else {
  console.error('Usage: npm run admin -- status|log|test|push-token|set KEY=VALUE');
  process.exit(1);
}

const res = await fetch(env.CENTRAL_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  redirect: 'follow',
});
console.log(JSON.stringify(await res.json(), null, 2));
