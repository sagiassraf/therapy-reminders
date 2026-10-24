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
console.log('✓ valid POST forwarded with internal token');

// ---- /onboard (Embedded Signup / Coexistence) ----
const envOn = { ...env, APP_ID: '111', ALLOWED_ORIGIN: 'https://site.example' };
const calls = [];
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  calls.push({ url, opt });
  const json = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/oauth/access_token')) return json(url.includes('code=good') ? { access_token: 'biztoken' } : { error: { message: 'bad code' } });
  if (url.includes('/debug_token')) return json({ data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba9'] }] } });
  if (url.includes('/waba9/phone_numbers')) return json({ data: [{ id: 'phone9' }] });
  if (url.includes('/waba9/subscribed_apps')) return json({ success: true });
  if (url.includes('/phone9?')) return json({ display_phone_number: '+972 50-111-2222', verified_name: 'Coach', is_on_biz_app: true, platform_type: 'CLOUD_API' });
  if (url === envOn.CENTRAL_URL) {
    const b = JSON.parse(opt.body);
    return json(b.secret === 'ksec' ? { ok: true, client: { displayName: 'מאמנת' } } : { ok: false, error: 'unauthorized client' });
  }
  return json({ error: { message: 'unexpected ' + url } });
};
const onboardReq = body => worker.fetch(new Request('https://w.dev/onboard', { method: 'POST', body: JSON.stringify(body) }), envOn, ctx);

res = await worker.fetch(new Request('https://w.dev/onboard', { method: 'OPTIONS' }), envOn, ctx);
assert.strictEqual(res.status, 204);
assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'https://site.example');

res = await onboardReq({ code: 'good' });
assert.strictEqual(res.status, 400, 'activation code required');

res = await onboardReq({ code: 'bad', activation: 'kc1.ksec' });
assert.strictEqual((await res.json()).step, 'token');

calls.length = 0;
res = await onboardReq({ code: 'good', activation: 'kc1.ksec' });
let out = await res.json();
assert.strictEqual(res.status, 200, JSON.stringify(out));
assert.deepStrictEqual([out.ok, out.coexistence, out.subscribed, out.number, out.therapist], [true, true, true, '+972 50-111-2222', 'מאמנת']);
assert(!JSON.stringify(out).includes('biztoken'), 'token never returned to the browser');
const central = JSON.parse(calls.find(c => c.url === envOn.CENTRAL_URL).opt.body);
assert.deepStrictEqual([central.action, central.clientId, central.wabaId, central.phoneId, central.waToken], ['connectWa', 'kc1', 'waba9', 'phone9', 'biztoken']);
assert(calls.some(c => c.url.includes('/waba9/subscribed_apps') && c.opt.method === 'POST'));

res = await onboardReq({ code: 'good', activation: 'kc1.wrong' });
out = await res.json();
assert.deepStrictEqual([res.status, out.step], [400, 'central']);
console.log('✓ /onboard: CORS, code exchange, WABA/phone discovery, subscribe, central handoff, no token leak');

console.log('\nALL WORKER TESTS PASSED');
