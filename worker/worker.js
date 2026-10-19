/**
 * Cloudflare Worker: WhatsApp webhook relay.
 * Meta needs a plain 200 response, which Apps Script web apps can't give (they redirect),
 * so this verifies the request and forwards it to the central Apps Script.
 *
 * Environment variables (Settings -> Variables, mark as "Secret"):
 *   VERIFY_TOKEN    any string; the same value goes in Meta's webhook settings
 *   APP_SECRET      Meta app secret (App settings -> Basic)
 *   CENTRAL_URL     central Apps Script web app URL (ends with /exec)
 *   INTERNAL_TOKEN  printed by setup() in the central script
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN;
      return ok
        ? new Response(url.searchParams.get('hub.challenge') || '', { status: 200 })
        : new Response('Forbidden', { status: 403 });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const body = await request.text();
    const signature = request.headers.get('X-Hub-Signature-256') || '';
    if (!(await validSignature(body, signature, env.APP_SECRET))) {
      return new Response('Bad signature', { status: 403 });
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }

    // Answer Meta right away; the forward to Apps Script (a few seconds) runs in the background.
    ctx.waitUntil(fetch(env.CENTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'webhook', token: env.INTERNAL_TOKEN, payload }),
      redirect: 'follow',
    }).catch(err => console.error('forward failed', err)));

    return new Response('OK', { status: 200 });
  },
};

export async function validSignature(body, signature, secret) {
  if (!secret || !signature.startsWith('sha256=')) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  const expected = Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
  const given = signature.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
