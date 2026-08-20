import { Resend } from 'resend';
import { emailTransport, env, isTest } from '../../config/index.js';
import { createModuleLogger } from '../logger/index.js';
import type { RenderedEmail } from './templates.js';

const log = createModuleLogger('email');

export interface OutboundEmail extends RenderedEmail {
  to: string;
  /** Categorises the send in logs and in Resend's dashboard. */
  kind: 'invitation' | 'login_otp' | 'password_reset' | 'password_changed';
}

export interface SendResult {
  delivered: boolean;
  /** Provider message id, when the provider accepted it. */
  messageId: string | null;
  transport: 'resend' | 'log';
}

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/**
 * Everything the `log` transport "sent". Development uses it to read a login
 * code without a mail account; tests assert on it. Never populated when the
 * Resend transport is active, and capped so a long dev session cannot grow it
 * without bound.
 */
const OUTBOX_LIMIT = 50;
const outbox: OutboundEmail[] = [];

export function readOutbox(): readonly OutboundEmail[] {
  return outbox;
}

export function lastEmailTo(recipient: string): OutboundEmail | undefined {
  return [...outbox].reverse().find((message) => message.to === recipient);
}

export function clearOutbox(): void {
  outbox.length = 0;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

/**
 * Sends a transactional email.
 *
 * Phase 4 moves this behind the queue so retries survive a restart. Until then
 * a login code has to be sent while the user waits, so delivery is inline with a
 * short bounded retry.
 *
 * Recipient addresses are logged as a `to` *hash*, never in the clear: this is
 * the one code path that necessarily handles a real address, and the logging
 * policy does not get an exception.
 */
export async function sendEmail(message: OutboundEmail): Promise<SendResult> {
  if (emailTransport === 'log' || !client) {
    outbox.push(message);
    if (outbox.length > OUTBOX_LIMIT) outbox.shift();

    // Development and tests: prove what would have been sent without sending it.
    log.info('email (log transport, not sent)', {
      kind: message.kind,
      subject: message.subject,
      recipientDomain: message.to.split('@')[1] ?? 'unknown',
      // Genuinely useful locally: the developer needs the code or the link.
      body: isTest ? undefined : message.text,
    });
    return { delivered: true, messageId: null, transport: 'log' };
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.emails.send({
        from: env.RESEND_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(env.RESEND_REPLY_TO ? { replyTo: env.RESEND_REPLY_TO } : {}),
        tags: [{ name: 'kind', value: message.kind }],
      });

      if (response.error) {
        throw new Error(`${response.error.name}: ${response.error.message}`);
      }

      log.info('email sent', {
        kind: message.kind,
        messageId: response.data?.id ?? null,
        attempt,
      });
      return { delivered: true, messageId: response.data?.id ?? null, transport: 'resend' };
    } catch (error) {
      lastError = error;
      log.warn('email send attempt failed', { kind: message.kind, attempt, err: error });

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)));
      }
    }
  }

  log.error('email delivery failed after retries', {
    kind: message.kind,
    attempts: MAX_ATTEMPTS,
    err: lastError,
  });
  return { delivered: false, messageId: null, transport: 'resend' };
}

export { emailTransport };
export * from './templates.js';
