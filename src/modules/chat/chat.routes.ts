import { Router } from 'express';
import { env } from '../../config/index.js';
import { createRateLimiter, validate } from '../../common/middleware/index.js';
import { sendSuccess } from '../../common/utils/response.js';
import { endSession, sendMessage, startSession, transcript } from './chat.controller.js';
import { sendMessageBody, startSessionBody } from './chat.schema.js';

/**
 * Per-IP budget for opening sessions.
 *
 * Its own limiter rather than the global one, and much tighter: every session is
 * a customer row, a conversation row and a token, so an unauthenticated endpoint
 * that creates three rows per call is the one thing on this API worth flooding.
 * Sending messages is limited per session inside the service instead, because
 * that is the limit a websocket frame can also be held to.
 */
const sessionRateLimit = createRateLimiter({
  name: 'chat-session',
  windowMs: 60_000,
  limit: 10,
});

/**
 * Mounted at /chat, and unauthenticated by design: the caller is a member of the
 * public who has not identified themselves and never will. The session token
 * issued by `POST /chat/sessions` is the credential for every call after it.
 */
export const chatRouter: Router = Router();

chatRouter.post('/sessions', sessionRateLimit, validate({ body: startSessionBody }), startSession);

// The session token in an `Authorization: Bearer` header, resolved by the
// controller — not by `authenticate`, which would make a visitor an actor.
chatRouter.post('/messages', validate({ body: sendMessageBody }), sendMessage);
chatRouter.get('/transcript', transcript);
chatRouter.delete('/session', endSession);

/** What the widget needs to know before it starts: is chat even on? */
chatRouter.get('/config', (_req, res) => {
  sendSuccess(res, {
    enabled: env.CHAT_ENABLED,
    namespace: env.CHAT_NAMESPACE,
    path: env.REALTIME_PATH,
  });
});
