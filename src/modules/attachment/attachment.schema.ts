import { z } from 'zod';

export const attachmentIdParams = z.object({ id: z.uuid() });
export const ticketIdParams = z.object({ ticketId: z.uuid() });

export const uploadUrlBody = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(3).max(255),
  /** Declared up front so an oversized file is refused before any bytes move. */
  sizeBytes: z.coerce.number().int().min(1),
});

export const confirmUploadBody = z.object({
  /** Links the attachment to the message it belongs to, once that exists. */
  messageId: z.uuid().optional(),
});

export type UploadUrlBody = z.infer<typeof uploadUrlBody>;
export type ConfirmUploadBody = z.infer<typeof confirmUploadBody>;
