import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, whatsappTransport } from '../../config/index.js';
import { createModuleLogger } from '../logger/index.js';

const log = createModuleLogger('whatsapp');

/**
 * Thin adapter over the WhatsApp Cloud API.
 *
 * Deliberately the same shape as `lib/resend`: a `send` that answers
 * `{ delivered, messageId, transport }`, a `log` transport that sends nothing
 * and records what it would have sent, and no domain knowledge whatsoever. The
 * `conversation` module decides *whether* to send; this file only knows how.
 *
 * One asymmetry with email is not this file's invention and cannot be hidden
 * here: WhatsApp only permits free-form text within 24 hours of the customer's
 * last message. Outside that window Meta rejects the send, and the only thing
 * that gets through is a pre-approved template. So `sendText` reports the
 * rejection faithfully and `sendTemplate` exists for the other side of the
 * window — the decision about which to call belongs to the caller that knows
 * when the customer last wrote.
 */
export interface WhatsappSendResult {
  delivered: boolean;
  /** Provider message id (`wamid.…`), when the provider accepted it. */
  messageId: string | null;
  transport: 'cloud' | 'log';
  /** Why the provider refused, for the outbound row. */
  error?: string;
}

export interface OutboundWhatsappMessage {
  /** E.164 without the leading `+`, which is what the Cloud API expects. */
  to: string;
  body: string;
  /** Categorises the send in logs, exactly as the email adapter's `kind` does. */
  kind: 'ticket_reply' | 'ticket_acknowledgement' | 'template';
}

/**
 * Everything the `log` transport "sent". Development reads it instead of
 * needing a Meta app; tests assert on it. Never populated when the cloud
 * transport is active, and capped so a long dev session cannot grow it without
 * bound.
 */
const OUTBOX_LIMIT = 50;
const outbox: OutboundWhatsappMessage[] = [];

export function readWhatsappOutbox(): readonly OutboundWhatsappMessage[] {
  return outbox;
}

export function clearWhatsappOutbox(): void {
  outbox.length = 0;
}

function record(message: OutboundWhatsappMessage): void {
  outbox.push(message);
  if (outbox.length > OUTBOX_LIMIT) outbox.shift();
}

/** Graph API version is pinned: Meta retires versions on a published schedule. */
const GRAPH_VERSION = 'v21.0';

function messagesUrl(): string {
  return `${env.WHATSAPP_API_BASE_URL}/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

/**
 * Sends a free-form text message.
 *
 * Fails soft, like `sendEmail`: an outbound message that the provider refuses
 * must not roll back the agent's reply, which is already in the thread and is
 * the record. The caller writes the failure onto the outbound row so the desk
 * can see the reply did not leave.
 */
export async function sendWhatsappText(
  message: OutboundWhatsappMessage,
): Promise<WhatsappSendResult> {
  if (whatsappTransport === 'log') {
    record(message);
    log.info('whatsapp message not sent: log transport', {
      to: redact(message.to),
      kind: message.kind,
    });
    return { delivered: true, messageId: null, transport: 'log' };
  }

  return post(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'text',
      // Link previews off: a support reply quoting a URL should not render
      // somebody else's page inside the conversation.
      text: { preview_url: false, body: message.body },
    },
    message,
  );
}

/**
 * Sends a pre-approved template, which is the only thing Meta accepts once the
 * 24-hour customer-service window has closed.
 *
 * The template itself is configured in Meta's console, not here: its text is
 * approved by Meta and versioned there, so a copy in this repository would be a
 * second source of truth that silently disagreed.
 */
export async function sendWhatsappTemplate(input: {
  to: string;
  templateName: string;
  languageCode: string;
  /** Positional body parameters, in the order the approved template declares. */
  parameters: readonly string[];
}): Promise<WhatsappSendResult> {
  const message: OutboundWhatsappMessage = {
    to: input.to,
    kind: 'template',
    body: `${input.templateName}(${input.parameters.join(', ')})`,
  };

  if (whatsappTransport === 'log') {
    record(message);
    log.info('whatsapp template not sent: log transport', {
      to: redact(input.to),
      template: input.templateName,
    });
    return { delivered: true, messageId: null, transport: 'log' };
  }

  return post(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: [
          {
            type: 'body',
            parameters: input.parameters.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    },
    message,
  );
}

async function post(
  payload: unknown,
  message: OutboundWhatsappMessage,
): Promise<WhatsappSendResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.WHATSAPP_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(messagesUrl(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      // Meta's error body carries the reason a send was refused — an expired
      // window, an unopted-in number — and the desk needs to see which, so it
      // is kept rather than flattened to "failed".
      const reason = extractError(text) ?? `HTTP ${response.status}`;
      log.warn('whatsapp send refused', {
        status: response.status,
        kind: message.kind,
        reason,
      });
      return { delivered: false, messageId: null, transport: 'cloud', error: reason };
    }

    const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
    const messageId = parsed.messages?.[0]?.id ?? null;

    return { delivered: true, messageId, transport: 'cloud' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    log.error('whatsapp send failed', { kind: message.kind, err: error });
    return { delivered: false, messageId: null, transport: 'cloud', error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

function extractError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    const message = parsed.error?.error_data?.details ?? parsed.error?.message;
    return message ? `${message}${parsed.error?.code ? ` (${parsed.error.code})` : ''}` : null;
  } catch {
    return body.slice(0, 200) || null;
  }
}

/** A phone number is PII; logs get enough to correlate and no more. */
function redact(value: string): string {
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
}

// -- inbound signature --------------------------------------------------------

export const SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Verifies Meta's `X-Hub-Signature-256`: `sha256=<hex>` of an HMAC-SHA256 over
 * the **exact bytes received**, keyed by the app secret.
 *
 * The raw buffer matters for the same reason it does on the Resend webhook —
 * re-serialising the parsed JSON changes whitespace and key order and the digest
 * no longer matches — which is why `app.ts` keeps `req.rawBody`.
 *
 * Fails closed on a missing secret. Without one, anyone who finds this URL can
 * inject messages attributed to any phone number, which is impersonating a
 * customer to the desk.
 */
export function verifyWhatsappSignature(input: {
  rawBody: Buffer | undefined;
  presented: string | undefined;
  appSecret: string | undefined;
}): boolean {
  if (!input.appSecret || !input.rawBody || !input.presented) return false;

  const expected = `sha256=${createHmac('sha256', input.appSecret).update(input.rawBody).digest('hex')}`;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(input.presented, 'utf8');
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
