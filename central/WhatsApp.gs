/**
 * WhatsApp Cloud API (Meta). Script properties used:
 *   WA_TOKEN       permanent System User access token
 *   WA_PHONE_ID    Phone number ID of the business number
 *   GRAPH_VERSION  optional, default v23.0
 *   TEMPLATE_LANG  optional, default he
 */

function waConfig_() {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('WA_TOKEN');
  const phoneId = p.getProperty('WA_PHONE_ID');
  if (!token || !phoneId) throw new Error('Missing WA_TOKEN or WA_PHONE_ID in script properties');
  return {
    token,
    phoneId,
    version: p.getProperty('GRAPH_VERSION') || 'v23.0',
    lang: p.getProperty('TEMPLATE_LANG') || 'he',
  };
}

function waSend_(message) {
  const cfg = waConfig_();
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
function sendTemplate_(phone, templateName, params, buttonPayloads) {
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
    template: { name: templateName, language: { code: waConfig_().lang }, components },
  });
}

/** Free-form text; only allowed within 24h of the client's last message to us. */
function sendText_(phone, text) {
  return waSend_({ to: phone, type: 'text', text: { preview_url: false, body: text } });
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
