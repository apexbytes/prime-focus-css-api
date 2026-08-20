import { z } from 'zod';

/**
 * Resend's `email.received` envelope. Only the fields this system acts on are
 * required — the payload is stored whole, so unknown fields are not lost.
 *
 * Notably the body is *not* here: Resend sends metadata only, and the text and
 * headers are fetched afterwards from the received-email API.
 */
export const inboundWebhookBody = z.looseObject({
  type: z.string().min(1),
  created_at: z.string().min(1),
  data: z.looseObject({
    email_id: z.string().min(1),
    created_at: z.string().min(1),
    from: z.string().min(3),
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    received_for: z.array(z.string()).optional(),
    message_id: z.string().optional(),
    subject: z.string().optional(),
    attachments: z
      .array(
        z.looseObject({
          id: z.string(),
          filename: z.string(),
          content_type: z.string(),
          content_disposition: z.string().optional(),
          content_id: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

/** Delivery/bounce/complaint events share one envelope shape. */
export const deliveryWebhookBody = z.looseObject({
  type: z.string().min(1),
  created_at: z.string().min(1),
  data: z.looseObject({ email_id: z.string().optional() }),
});

export const inboundIdParams = z.object({ id: z.uuid() });

export type InboundWebhookBody = z.infer<typeof inboundWebhookBody>;
