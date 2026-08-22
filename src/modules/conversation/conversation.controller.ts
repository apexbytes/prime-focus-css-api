import type { Request, Response } from 'express';
import { env } from '../../config/index.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { secureEquals } from '../../common/utils/crypto.js';
import { sendSuccess } from '../../common/utils/response.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { SIGNATURE_HEADER, verifyWhatsappSignature } from '../../lib/whatsapp/index.js';
import * as conversationService from './conversation.service.js';
import type { ListConversationsQuery, WhatsappWebhookBody } from './conversation.schema.js';

const log = createModuleLogger('conversation:webhook');

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

/**
 * Meta's URL verification handshake.
 *
 * Answers with the raw challenge string and nothing else — no response
 * envelope, no `success: true`. Meta compares the body byte for byte and a
 * wrapped challenge fails the check, which is why this is the one endpoint in
 * the system that does not use `sendSuccess`.
 */
export function verifyWebhook(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (!env.WHATSAPP_VERIFY_TOKEN) {
    throw new AppError(
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      'WhatsApp is not configured on this deployment',
    );
  }

  // Constant-time, even though this runs once at configuration time: the
  // endpoint is public and there is no reason to make it the one comparison in
  // the codebase that leaks a prefix.
  if (
    mode !== 'subscribe' ||
    typeof token !== 'string' ||
    !secureEquals(token, env.WHATSAPP_VERIFY_TOKEN)
  ) {
    log.warn('rejected a webhook verification with a bad token');
    throw AppError.forbidden('Verification failed');
  }

  res.type('text/plain').send(typeof challenge === 'string' ? challenge : '');
}

/**
 * Accepts an inbound WhatsApp webhook.
 *
 * Verifies, persists, answers 202, then queues the filing — the same
 * persist-then-process shape as the inbound email webhook, and for the same
 * reason: Meta retries anything that is not a prompt 2xx, and a retried webhook
 * that is slow rather than broken turns one customer message into several.
 *
 * One envelope can carry several messages, and each becomes its own durable row.
 * A malformed one among them must not cost the others, so each is recorded
 * independently and a failure is logged rather than thrown.
 */
export async function receiveWhatsapp(req: Request, res: Response): Promise<void> {
  verifySignature(req);

  const body = req.body as WhatsappWebhookBody;
  const accepted: string[] = [];
  let duplicates = 0;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value;

      // Delivery and read receipts. Recorded nowhere for now: this system does
      // not show a customer's read state to agents, and a row per receipt on a
      // busy number is a large table nobody reads. The branch exists so a
      // status envelope is not mistaken for an empty message envelope.
      if (value.statuses?.length && !value.messages?.length) continue;

      const profileName = value.contacts?.[0]?.profile?.name;

      for (const message of value.messages ?? []) {
        // Anything that is not text: an image, a voice note, a location. The
        // desk cannot read it and this phase does not download media, so it is
        // recorded with no body and the pipeline ignores it — visibly, in the
        // inbound log, rather than being dropped on the floor here.
        const text = message.type === 'text' ? (message.text?.body ?? null) : null;

        try {
          const { id, duplicate } = await conversationService.recordInbound({
            channel: 'whatsapp',
            providerMessageId: message.id,
            // The customer's number is the thread: a WhatsApp conversation with
            // a number is the same conversation forever.
            conversationExternalId: message.from,
            fromIdentifier: message.from,
            ...(profileName ? { displayName: profileName } : {}),
            body: text,
            payload: { entryId: entry.id, message, metadata: value.metadata },
            ...(message.timestamp
              ? { occurredAt: new Date(Number(message.timestamp) * 1000) }
              : {}),
          });

          if (duplicate) {
            duplicates += 1;
            continue;
          }

          accepted.push(id);
          await conversationService.queueInbound(id);
        } catch (error) {
          // Never a 5xx: Meta would redeliver the whole envelope, including the
          // messages that were recorded successfully.
          log.error('failed to record an inbound whatsapp message', {
            providerMessageId: message.id,
            err: error,
          });
        }
      }
    }
  }

  sendSuccess(res, { accepted: accepted.length, duplicates }, { status: 202 });
}

function verifySignature(req: Request): void {
  if (!env.WHATSAPP_APP_SECRET) {
    // Refusing is the safe default: without a secret anyone who finds this URL
    // could post messages to the desk as any phone number, which is
    // impersonating a customer.
    throw new AppError(
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      'WhatsApp is not configured on this deployment',
    );
  }

  const ok = verifyWhatsappSignature({
    rawBody: req.rawBody,
    presented: req.get(SIGNATURE_HEADER),
    appSecret: env.WHATSAPP_APP_SECRET,
  });

  if (!ok) {
    log.warn('rejected a whatsapp webhook with an invalid signature');
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Invalid webhook signature');
  }
}

// -- staff surface ------------------------------------------------------------

export async function listConversations(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListConversationsQuery;

  const { items, hasMore } = await conversationService.list(
    {
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    },
    actorOf(req),
  );

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
    },
  });
}

/** The backlog: messages recorded but not yet filed onto a ticket. */
export async function listUnprocessed(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await conversationService.listUnprocessed(100));
}

/** Retries a failed filing; the durable row makes this safe to repeat. */
export async function reprocessInbound(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await conversationService.processInbound(req.params.id as string));
}
