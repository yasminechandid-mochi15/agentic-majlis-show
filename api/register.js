// Vercel serverless function: POST /api/register
//
// Receives a seat request from the registration form on the page, checks it,
// and forwards it to the HubSpot form. It only replies "success" (with a
// registration ID) after HubSpot has confirmed it accepted the submission.
// The registration ID is sent to HubSpot inside the same submission, so the ID
// the guest sees is always stored on their HubSpot contact record.
//
// No secret keys are needed: HubSpot's form-submission endpoint only uses the
// public Portal ID and Form ID. Nothing personal is logged here.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// SETTINGS. All values below were confirmed in HubSpot. If any field name is
// ever emptied (null), the function refuses every submission (the page shows
// its "Something went wrong" message), so nobody is ever told they are
// registered when they are not.
// ---------------------------------------------------------------------------
const CONFIG = {
  portalId: process.env.HUBSPOT_PORTAL_ID || '147199682',
  formId: process.env.HUBSPOT_FORM_ID || '99517551-dde4-42cd-9061-9d94bc054bfe',
  apiHost: 'https://api-eu1.hsforms.com', // HubSpot EU data centre (eu1)

  // Must match data-closes-at in index.html: 20 November 2026, 23:59 Dubai time.
  closesAt: '2026-11-20T23:59:59+04:00',

  // Website addresses allowed to send registrations (besides the site's own
  // address, which is always allowed). Can be overridden in Vercel with the
  // ALLOWED_ORIGINS setting, comma-separated.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://events.ibexa.ai')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // HubSpot INTERNAL names of the fields on the HubSpot form. TO VERIFY.
  // (HubSpot > Marketing > Forms > open the form > click a field: the internal
  // name is shown under the property, e.g. "firstname".)
  // Confirmed in HubSpot by the Ibexa team (November 2026).
  fields: {
    first_name: 'firstname',
    last_name: 'lastname',
    job_title: 'jobtitle',
    company: 'company',
    work_email: 'email',
    mobile: 'mobilephone',
    dietary: 'dietary_restrictions',   // Multiple checkboxes
    registration_id: 'registration_id', // single-line text, hidden field on the form
  },

  // dietary_restrictions is a Multiple checkboxes field: each website choice is
  // mapped to the HubSpot option's INTERNAL value (confirmed in HubSpot).
  dietaryValues: {
    'None': 'None',
    'Vegetarian': 'Vegetarian',
    'Vegan': 'Vegan',
    'Gluten-free': 'Gluten-free',
    'Nut allergy': 'Nut allergy',
    'Other (please specify)': 'Other (please specify)',
  },
  // Free-text description the guest types when they choose "Other".
  dietaryOtherField: 'other_dietary_restrictions', // Multi-line text

  // Subscription type for the optional marketing checkbox:
  // "Ibexa - Marketing Information" (confirmed in HubSpot).
  // Guests are only subscribed when they ticked that box themselves.
  marketingSubscriptionTypeId: process.env.HUBSPOT_MARKETING_SUBSCRIPTION_ID || '1514031522',
};

// Exact wording the guest sees next to each checkbox on the page. Sent to
// HubSpot as the consent record, so it must stay identical to index.html.
const CONSENT_TEXT = {
  event: 'I agree that my details will be used to manage my registration for The Agentic Majlis Show, and shared with Ibexa’s event partner for that purpose only.',
  marketing: 'Yes, Ibexa may contact me by email or phone about this event and about Ibexa’s products, services and events. I can withdraw my consent at any time by using the unsubscribe link in any email or by contacting Ibexa.',
};

const DIETARY_CHOICES = ['None', 'Vegetarian', 'Vegan', 'Gluten-free', 'Nut allergy', 'Other (please specify)'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // same style as the page: AMS26-XXXXXX
const MIN_FILL_MS = 2500; // same "filled in too fast" spam check as the page
const HUBSPOT_TIMEOUT_MS = 10000;

function missingSettings() {
  const missing = Object.entries(CONFIG.fields).filter(([, v]) => !v).map(([k]) => `fields.${k}`);
  if (!CONFIG.marketingSubscriptionTypeId) missing.push('marketingSubscriptionTypeId');
  // The HubSpot dietary field is Multiple checkboxes: option values must be mapped.
  if (!CONFIG.dietaryValues) missing.push('dietaryValues');
  return missing;
}

function newRegistrationId() {
  let id = '';
  for (let i = 0; i < 6; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return `AMS26-${id}`;
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let originHost;
  try { originHost = new URL(origin).host; } catch { return false; }
  const ownHosts = [req.headers['x-forwarded-host'], req.headers.host].filter(Boolean);
  if (ownHosts.includes(originHost)) return true;
  return CONFIG.allowedOrigins.includes(origin);
}

// Same rules as the form on the page. Returns a clean record, or null if invalid.
function validate(b) {
  const lengthOk = (v, min, max) => v.length >= min && v.length <= max;
  const r = {
    first_name: text(b.first_name),
    last_name: text(b.last_name),
    job_title: text(b.job_title),
    company: text(b.company),
    work_email: text(b.work_email).toLowerCase(),
    mobile: text(b.mobile),
    dietary: text(b.dietary) || 'None',
  };
  if (!lengthOk(r.first_name, 1, 60)) return null;
  if (!lengthOk(r.last_name, 1, 60)) return null;
  if (!lengthOk(r.job_title, 2, 100)) return null;
  if (!lengthOk(r.company, 2, 120)) return null;
  if (r.work_email.length > 254 || !EMAIL_RE.test(r.work_email)) return null;
  // The page sends the mobile as country code + number, e.g. +971501234567.
  if (!/^\+\d{7,18}$/.test(r.mobile)) return null;
  // The page sends a dietary choice, or "Other: <their text>".
  if (r.dietary.startsWith('Other:')) {
    r.dietary_other = r.dietary.slice('Other:'.length).trim().slice(0, 120);
    r.dietary_choice = 'Other (please specify)';
  } else if (DIETARY_CHOICES.includes(r.dietary)) {
    r.dietary_choice = r.dietary;
  } else {
    return null;
  }
  // The required registration consent box must be ticked.
  if (b.consent_event !== true) return null;
  // Optional marketing box: only an explicit "yes" counts as consent.
  r.consent_marketing = b.consent_contact === 'yes';
  return r;
}

function buildHubSpotPayload(r, regId, pageUri) {
  const f = CONFIG.fields;
  const field = (name, value) => ({ objectTypeId: '0-1', name, value });

  let dietaryValue = r.dietary; // plain text field: send the website's wording
  if (CONFIG.dietaryValues) {
    dietaryValue = CONFIG.dietaryValues[r.dietary_choice];
    if (dietaryValue === undefined) throw new Error('dietary choice not mapped');
  }

  const fields = [
    field(f.first_name, r.first_name),
    field(f.last_name, r.last_name),
    field(f.job_title, r.job_title),
    field(f.company, r.company),
    field(f.work_email, r.work_email),
    field(f.mobile, r.mobile),
    field(f.dietary, dietaryValue),
    field(f.registration_id, regId),
  ];
  if (CONFIG.dietaryValues && CONFIG.dietaryOtherField && r.dietary_other) {
    fields.push(field(CONFIG.dietaryOtherField, r.dietary_other));
  }

  const consent = {
    consentToProcess: true,
    text: CONSENT_TEXT.event,
    communications: [],
  };
  // Marketing subscription is only included when the guest ticked the box.
  if (r.consent_marketing) {
    consent.communications.push({
      value: true,
      subscriptionTypeId: Number(CONFIG.marketingSubscriptionTypeId),
      text: CONSENT_TEXT.marketing,
    });
  }

  const payload = {
    submittedAt: Date.now(),
    fields,
    legalConsentOptions: { consent },
    context: { pageName: 'The Agentic Majlis Show' },
  };
  if (pageUri) payload.context.pageUri = pageUri;
  return payload;
}

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { error: 'method_not_allowed' });
  }
  if (!originAllowed(req)) return reply(res, 403, { error: 'forbidden' });

  const missing = missingSettings();
  if (missing.length) {
    console.error('[register] Not configured yet. Missing HubSpot settings:', missing.join(', '));
    return reply(res, 503, { error: 'not_configured' });
  }

  if (Date.now() > Date.parse(CONFIG.closesAt)) return reply(res, 403, { error: 'closed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object' || JSON.stringify(body).length > 10000) {
    return reply(res, 400, { error: 'bad_request' });
  }

  // Spam traps: hidden field filled in, or form completed impossibly fast.
  if (text(body.website) || !(Number(body.fill_ms) >= MIN_FILL_MS)) {
    return reply(res, 400, { error: 'rejected' });
  }

  const record = validate(body);
  if (!record) return reply(res, 400, { error: 'invalid' });

  const regId = newRegistrationId();
  let pageUri = '';
  const referer = req.headers.referer;
  if (referer) {
    try { pageUri = new URL(referer).origin + new URL(referer).pathname; } catch { /* ignore */ }
  }

  let hubspotRes;
  try {
    const payload = buildHubSpotPayload(record, regId, pageUri);
    hubspotRes = await fetch(
      `${CONFIG.apiHost}/submissions/v3/integration/submit/${CONFIG.portalId}/${CONFIG.formId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HUBSPOT_TIMEOUT_MS),
      },
    );
  } catch (err) {
    console.error('[register] Could not reach HubSpot:', err && err.name);
    return reply(res, 502, { error: 'hubspot_unreachable' });
  }

  if (!hubspotRes.ok) {
    // Log only HubSpot's error codes (e.g. FIELD_NOT_IN_FORM_DEFINITION), never
    // the guest's details.
    let codes = '';
    try {
      const data = await hubspotRes.json();
      codes = (data.errors || []).map((e) => e.errorType).join(', ');
    } catch { /* ignore */ }
    console.error(`[register] HubSpot rejected the submission: HTTP ${hubspotRes.status} ${codes}`);
    return reply(res, 502, { error: 'hubspot_rejected' });
  }

  // HubSpot confirmed. Only now does the page show "Your request is in."
  return reply(res, 200, { reg_id: regId });
};
