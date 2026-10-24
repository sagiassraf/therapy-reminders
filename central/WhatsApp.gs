/**
 * WhatsApp Cloud API (Meta). Script properties used:
 *   WA_TOKEN       permanent System User access token
 *   WA_PHONE_ID    Phone number ID of the business number
 *   GRAPH_VERSION  optional, default v25.0
 *   TEMPLATE_LANG  optional, default he
 *   WA_CLIENT_<id> set by the connect flow: {wabaId, phoneId, token, display} of a therapist's
 *                  own WhatsApp Business number (Coexistence). Messages to that therapist's
 *                  clients go out from it; everything else uses the central number above.
 */

function ownNumber_(client) {
  if (!client || !client.id) return null;
  const raw = PropertiesService.getScriptProperties().getProperty('WA_CLIENT_' + client.id);
  return raw ? JSON.parse(raw) : null;
}

function waConfig_(client) {
  const p = PropertiesService.getScriptProperties();
  const own = ownNumber_(client);
  const token = own ? own.token : p.getProperty('WA_TOKEN');
  const phoneId = own ? own.phoneId : p.getProperty('WA_PHONE_ID');
  if (!token || !phoneId) throw new Error('Missing WA_TOKEN or WA_PHONE_ID in script properties');
  return {
    token,
    phoneId,
    version: p.getProperty('GRAPH_VERSION') || 'v25.0',
    lang: p.getProperty('TEMPLATE_LANG') || 'he',
  };
}

/** `client` (optional) sends from that therapist's own number when one is connected. */
function waSend_(message, client) {
  const cfg = waConfig_(client);
  const res = UrlFetchApp.fetch(`https://graph.facebook.com/${cfg.version}/${cfg.phoneId}/messages`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.token },
    payload: JSON.stringify(Object.assign({ messaging_product: 'whatsapp', recipient_type: 'individual' }, message)),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error('WhatsApp ' + code + ': ' + text.slice(0, 500));
  return JSON.parse(text);
}

/**
 * Sends an approved template. `buttonPayloads` fills the template's quick-reply
 * buttons in order (index 0, 1, ...); pass [] for templates without buttons.
 */
function sendTemplate_(phone, templateName, params, buttonPayloads, client) {
  const components = [{
    type: 'body',
    parameters: params.map(t => ({ type: 'text', text: String(t) })),
  }];
  buttonPayloads.forEach((payload, i) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(i),
      parameters: [{ type: 'payload', payload }],
    });
  });
  return waSend_({
    to: phone,
    type: 'template',
    template: { name: templateName, language: { code: waConfig_(client).lang }, components },
  }, client);
}

/** Free-form text; only allowed within 24h of the client's last message to us. */
function sendText_(phone, text, client) {
  return waSend_({ to: phone, type: 'text', text: { preview_url: false, body: text } }, client);
}

/** Creates a template set's templates on a therapist's own WhatsApp account (see Templates.gs). */
function createTemplatesFor_(client) {
  const own = ownNumber_(client);
  if (!own || !own.wabaId) throw new Error('No WhatsApp number connected for ' + client.id);
  const defs = TEMPLATE_DEFS[client.templateSet || 'default'];
  if (!defs) throw new Error('No template definitions for set ' + client.templateSet);
  const version = PropertiesService.getScriptProperties().getProperty('GRAPH_VERSION') || 'v25.0';
  return defs.map(def => {
    const res = UrlFetchApp.fetch(`https://graph.facebook.com/${version}/${own.wabaId}/message_templates`, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + own.token },
      payload: JSON.stringify(def),
      muteHttpExceptions: true,
    });
    const body = JSON.parse(res.getContentText() || '{}');
    return { name: def.name, status: body.status || (body.error && body.error.message) || res.getResponseCode() };
  });
}

/** Any Israeli/international format -> digits with country code, e.g. 972501234567. '' if invalid. */
function normalizePhone_(value) {
  let d = String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  if (d.length < 11 || d.length > 15) return '';
  return d;
}

/** 972501234567 -> 050-1234567 (for showing a number to clients). */
function formatLocalPhone_(phone) {
  const d = String(phone);
  if (!d.startsWith('972')) return '+' + d;
  const local = '0' + d.slice(3);
  return local.length === 10 ? local.slice(0, 3) + '-' + local.slice(3) : local.slice(0, 2) + '-' + local.slice(2);
}
