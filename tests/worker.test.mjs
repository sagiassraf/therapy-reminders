import assert from 'node:assert';
import crypto from 'node:crypto';
import worker from '../worker/worker.js';

const env = { VERIFY_TOKEN: 'vt', APP_SECRET: 'appsecret', CENTRAL_URL: 'https://central.example/exec', INTERNAL_TOKEN: 'it' };
const forwarded = [];
globalThis.fetch = async (url, opt) => { forwarded.push({ url, opt }); return new Response('ok'); };
const waits = [];
const ctx = { waitUntil: p => waits.push(p) };

let res = await worker.fetch(new Request('https://w.dev/?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=12345'), env, ctx);
assert.strictEqual(res.status, 200);
assert.strictEqual(await res.text(), '12345');
res = await worker.fetch(new Request('https://w.dev/?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1'), env, ctx);
assert.strictEqual(res.status, 403);
console.log('✓ GET verification');

const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [] } }] }] });
const sig = 'sha256=' + crypto.createHmac('sha256', env.APP_SECRET).update(body).digest('hex');
res = await worker.fetch(new Request('https://w.dev/', { method: 'POST', body, headers: { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) } }), env, ctx);
assert.strictEqual(res.status, 403);
res = await worker.fetch(new Request('https://w.dev/', { method: 'POST', body }), env, ctx);
assert.strictEqual(res.status, 403);
console.log('✓ bad/missing signature rejected');

res = await worker.fetch(new Request('https://w.dev/', { method: 'POST', body, headers: { 'X-Hub-Signature-256': sig } }), env, ctx);
assert.strictEqual(res.status, 200);
await Promise.all(waits);
assert.strictEqual(forwarded.length, 1);
const fw = JSON.parse(forwarded[0].opt.body);
assert.strictEqual(forwarded[0].url, env.CENTRAL_URL);
assert.deepStrictEqual(fw, { type: 'webhook', token: 'it', payload: JSON.parse(body) });
console.log('✓ valid POST forwarded with internal token\n\nALL WORKER TESTS PASSED');
