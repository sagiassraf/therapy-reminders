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
 *   APP_ID          Meta app id (for the /onboard token exchange)
 *   ALLOWED_ORIGIN  site that hosts the "connect WhatsApp" page, e.g. https://example.workers.dev
 *
 * POST /onboard finishes Embedded Signup for a therapist connecting their own WhatsApp
 * Business number (Coexistence): code -> business token, subscribe our app to their account,
 * then hand the details to central, which checks the therapist's activation code.
 */

const GRAPH = 'https://graph.facebook.com/v25.0';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/onboard') return handleOnboard(request, env);

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

function withCors(response, env) {
  response.headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '');
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  response.headers.set('Vary', 'Origin');
  return response;
}

async function handleOnboard(request, env) {
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), env);
  if (request.method !== 'POST') return withCors(new Response('Method not allowed', { status: 405 }), env);
  let body;
  try {
    body = await request.json();
  } catch {
    return withCors(Response.json({ ok: false, error: 'bad json' }, { status: 400 }), env);
  }
  const result = await onboard(body, env);
  return withCors(Response.json(result, { status: result.ok ? 200 : 400 }), env);
}

async function graph(path, token, init = {}) {
  const res = await fetch(GRAPH + path, {
    ...init,
    headers: { ...(init.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  return res.json();
}

export async function onboard({ code, activation, waba_id, phone_number_id }, env) {
  const m = /^(\w+)\.(\w+)$/.exec(String(activation || '').trim());
  if (!code || !m) return { ok: false, step: 'input', error: 'missing code or activation code' };

  // The code is only valid for ~30 seconds, so exchange it first.
  const qs = new URLSearchParams({ client_id: env.APP_ID, client_secret: env.APP_SECRET, code });
  const exchanged = await graph('/oauth/access_token?' + qs);
  if (!exchanged.access_token) {
    return { ok: false, step: 'token', error: (exchanged.error && exchanged.error.message) || 'token exchange failed' };
  }
  const token = exchanged.access_token;

  let wabaId = waba_id;
  if (!wabaId) {
    const dbg = await graph('/debug_token?' + new URLSearchParams({ input_token: token, access_token: `${env.APP_ID}|${env.APP_SECRET}` }));
    const scope = ((dbg.data && dbg.data.granular_scopes) || []).find(s => s.scope === 'whatsapp_business_management');
    wabaId = scope && scope.target_ids && scope.target_ids[0];
  }
  if (!wabaId) return { ok: false, step: 'waba', error: 'no WhatsApp account was shared' };

  let phoneId = phone_number_id;
  if (!phoneId) {
    const nums = await graph(`/${wabaId}/phone_numbers?fields=id`, token);
    phoneId = nums.data && nums.data[0] && nums.data[0].id;
  }
  if (!phoneId) return { ok: false, step: 'phone', error: 'no phone number on the WhatsApp account' };

  // Deliver this account's webhooks (button taps, replies) to our app.
  const sub = await graph(`/${wabaId}/subscribed_apps`, token, { method: 'POST' });
  const info = await graph(`/${phoneId}?fields=display_phone_number,verified_name,is_on_biz_app,platform_type`, token);

  const saved = await fetch(env.CENTRAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      type: 'admin', token: env.INTERNAL_TOKEN, action: 'connectWa',
      clientId: m[1], secret: m[2], wabaId, phoneId, waToken: token, display: info.display_phone_number || '',
    }),
  }).then(r => r.json()).catch(err => ({ ok: false, error: String(err) }));

  return {
    ok: !!saved.ok,
    step: saved.ok ? 'done' : 'central',
    error: saved.ok ? undefined : saved.error,
    therapist: saved.client && saved.client.displayName,
    number: info.display_phone_number,
    name: info.verified_name,
    coexistence: info.is_on_biz_app === true,
    platform: info.platform_type,
    subscribed: sub.success === true,
  };
}

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
