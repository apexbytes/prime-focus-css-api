import { z } from 'zod';
import { CONVERSATION_CHANNELS } from './conversation.types.js';

/**
 * The subset of Meta's `messages` webhook this system relies on.
 *
 * Deliberately loose in the places Meta is: `entry` and `changes` are arrays
 * that in practice hold one element, `type` grows new values whenever Meta ships
 * a feature, and unknown keys are ignored rather than rejected. A strict schema
 * here would turn every product announcement into an outage on a webhook we
 * cannot afford to reject — and what actually matters, the signature, is checked
 * before this schema ever runs.
 */
/**
 * Every media type carries the same core: an **id**, never a URL. Resolving it
 * is two further calls — see `lib/whatsapp`. `caption` appears on images,
 * videos and documents; `filename` only on documents; `voice` distinguishes a
 * recorded note from an attached audio file.
 */
const whatsappMedia = z
  .object({
    id: z.string().min(1),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
    filename: z.string().optional(),
    voice: z.boolean().optional(),
  })
  .loose();

const whatsappInboundMessage = z.object({
  from: z.string().min(1),
  id: z.string().min(1),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: whatsappMedia.optional(),
  document: whatsappMedia.optional(),
  audio: whatsappMedia.optional(),
  video: whatsappMedia.optional(),
  sticker: whatsappMedia.optional(),
  /** Present on a reply to one of our own messages; kept for the payload log. */
  context: z.object({ id: z.string().optional() }).loose().optional(),
});

const whatsappStatus = z.object({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.string().optional(),
  recipient_id: z.string().optional(),
});

const whatsappValue = z.object({
  messaging_product: z.string().optional(),
  metadata: z
    .object({ display_phone_number: z.string().optional(), phone_number_id: z.string().optional() })
    .loose()
    .optional(),
  contacts: z
    .array(
      z
        .object({
          wa_id: z.string().optional(),
          profile: z.object({ name: z.string().optional() }).loose().optional(),
        })
        .loose(),
    )
    .optional(),
  messages: z.array(whatsappInboundMessage).optional(),
  statuses: z.array(whatsappStatus).optional(),
});

export const whatsappWebhookBody = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        changes: z
          .array(z.object({ field: z.string().optional(), value: whatsappValue }))
          .optional(),
      }),
    )
    .default([]),
});

export type WhatsappWebhookBody = z.infer<typeof whatsappWebhookBody>;
export type WhatsappInboundMessage = z.infer<typeof whatsappInboundMessage>;

/**
 * Meta's webhook URL verification, which arrives as a `GET` with the token in
 * the query string.
 *
 * This is the one place in the system where a shared secret travels in a URL,
 * and it is not ours: Meta's console defines the handshake. It is mitigated by
 * `WHATSAPP_VERIFY_TOKEN` being a value with no other power — it verifies a URL
 * once at configuration time and signs nothing, which is exactly why it is a
 * separate setting from `WHATSAPP_APP_SECRET`.
 */
export const whatsappVerifyQuery = z.object({
  'hub.mode': z.string().optional(),
  'hub.verify_token': z.string().optional(),
  'hub.challenge': z.string().optional(),
});

export const listConversationsQuery = z.object({
  channel: z.enum(CONVERSATION_CHANNELS).optional(),
  status: z.enum(['open', 'closed']).optional(),
  productId: z.uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuery>;

export const inboundIdParams = z.object({ id: z.uuid() });

export const conversationIdParams = z.object({ id: z.uuid() });
