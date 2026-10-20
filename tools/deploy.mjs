// Pushes code to Apps Script with clasp. Values come from the git-ignored .env:
//   npm run deploy:central    CENTRAL_SCRIPT_ID, CENTRAL_DEPLOYMENT_ID -> push + update the web app version
//   npm run deploy:connector  CONNECTOR_SCRIPT_ID, CENTRAL_URL         -> push the therapist template
// The connector is built into .build/ so the real CENTRAL_URL never lands in the (public) repo.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
  .split(/\r?\n/).filter(l => /^\w+=/.test(l)).map(l => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]));

function need(key) {
  if (!env[key]) throw new Error(`Missing ${key} in .env`);
  return env[key];
}

function writeClasp(dir, scriptId) {
  fs.writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify({
    scriptId, rootDir: '.', scriptExtensions: ['.gs', '.js'], jsonExtensions: ['.json'],
  }, null, 2));
}

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });
const target = process.argv[2];

if (target === 'central') {
  const dir = path.join(ROOT, 'central');
  writeClasp(dir, need('CENTRAL_SCRIPT_ID'));
  run('clasp push --force', dir);
  run(`clasp update-deployment ${need('CENTRAL_DEPLOYMENT_ID')} --description "deploy ${new Date().toISOString()}"`, dir);
} else if (target === 'connector') {
  const src = path.join(ROOT, 'connector');
  const out = path.join(ROOT, '.build', 'connector');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const code = fs.readFileSync(path.join(src, 'Code.gs'), 'utf8');
  if (!code.includes('PASTE_CENTRAL_WEB_APP_URL_HERE')) throw new Error('CENTRAL_URL placeholder not found in connector/Code.gs');
  fs.writeFileSync(path.join(out, 'Code.gs'), code.replace('PASTE_CENTRAL_WEB_APP_URL_HERE', need('CENTRAL_URL')));
  fs.copyFileSync(path.join(src, 'appsscript.json'), path.join(out, 'appsscript.json'));
  writeClasp(out, need('CONNECTOR_SCRIPT_ID'));
  run('clasp push --force', out);
} else {
  console.error('Usage: node tools/deploy.mjs central|connector');
  process.exit(1);
}
