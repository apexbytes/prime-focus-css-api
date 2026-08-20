import type { Request, Response } from 'express';
import { Resend } from 'resend';
import { env } from '../../config/index.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/utils/response.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as emailService from './email.service.js';
import type { InboundWebhookBody } from './email.schema.js';

const log = createModuleLogger('email:webhook');

/**
 * Verification is pure HMAC over the request body — it makes no API call — so a
 * placeholder key is fine when none is configured. Built unconditionally on
 * purpose: an optional client would mean `verify` silently doing nothing on a
 * deployment that has a webhook secret but no API key, which is fail-open.
 */
const verifier = new Resend(env.RESEND_API_KEY ?? 're_verification_only');

/**
 * Confirms the request really came from Resend.
 *
 * The signature covers the exact bytes received, which is why the JSON parser
 * keeps `rawBody`. Re-serialising the parsed object would change whitespace and
 * key order, and the check would fail.
 */
function verifySignature(req: Request): void {
  if (!env.RESEND_WEBHOOK_SECRET) {
    // Refusing is the safe default: without a secret anyone who finds this URL
    // could inject tickets and impersonate customers.
    throw new AppError(
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      'Inbound email is not configured on this deployment',
    );
  }

  const id = req.get('svix-id');
  const timestamp = req.get('svix-timestamp');
  const signature = req.get('svix-signature');

  if (!id || !timestamp || !signature || !req.rawBody) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Missing webhook signature headers');
  }

  try {
    verifier.webhooks.verify({
      payload: req.rawBody.toString('utf8'),
      headers: { id, timestamp, signature },
      webhookSecret: env.RESEND_WEBHOOK_SECRET,
    });
  } catch (error) {
    log.warn('rejected a webhook with an invalid signature', { svixId: id, err: error });
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Invalid webhook signature');
  }
}

/**
 * Accepts an inbound email.
 *
 * Persists and answers 200 immediately, then files the message. A provider that
 * receives a 5xx or a timeout retries, so slow work must not happen inline —
 * and because the row is written first, nothing is lost if processing fails.
 */
export async function receiveInbound(req: Request, res: Response): Promise<void> {
  verifySignature(req);

  const body = req.body as InboundWebhookBody;
  if (body.type !== 'email.received') {
    log.info('ignored a webhook of an unexpected type', { type: body.type });
    sendSuccess(res, { accepted: false, reason: `unhandled type ${body.type}` }, { status: 202 });
    return;
  }

  const { id, duplicate } = await emailService.recordInbound(body);
  sendSuccess(res, { accepted: true, inboundEmailId: id, duplicate }, { status: 202 });

  if (duplicate) return;

  // Deliberately not awaited: the response is already sent. Phase 4 replaces
  // this with a queued job so a crash retries automatically instead of relying
  // on the reprocess endpoint.
  void emailService.processInbound(id).catch((error: unknown) => {
    log.error('inbound processing threw', { inboundEmailId: id, err: error });
  });
}

/** Delivery, bounce and complaint notifications. */
export async function receiveDeliveryEvent(req: Request, res: Response): Promise<void> {
  verifySignature(req);

  const body = req.body as { type: string; created_at: string; data?: { email_id?: string } };

  await emailService.recordDeliveryEvent({
    providerMessageId: body.data?.email_id ?? null,
    event: body.type,
    payload: body,
    occurredAt: new Date(body.created_at),
  });

  sendSuccess(res, { accepted: true }, { status: 202 });
}

/** Retries a failed inbound email; the durable row makes this safe to repeat. */
export async function reprocessInbound(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await emailService.processInbound(req.params.id as string));
}

export async function listUnprocessed(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await emailService.listUnprocessed(100));
}
