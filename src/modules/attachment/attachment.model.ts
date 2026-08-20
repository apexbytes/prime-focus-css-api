import { bigint, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { customers } from '../customer/customer.model.js';
import { ticketMessages } from '../message/message.model.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

/**
 * `pending` until the client confirms the upload, so a row without bytes behind
 * it is distinguishable from a complete one. Virus scanning is a Phase 4 job;
 * until then uploads land as `skipped` rather than pretending to be clean.
 */
export const attachmentStatus = pgEnum('attachment_status', [
  'pending',
  'uploaded',
  'clean',
  'infected',
  'skipped',
  'failed',
]);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Null while the attachment is being uploaded ahead of its message. */
    messageId: uuid('message_id').references(() => ticketMessages.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    /** bigint: a 2 GB file would overflow int4, and the cap is configurable. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Opaque path in the object store; never derived from the filename. */
    storageKey: text('storage_key').notNull().unique(),
    checksum: text('checksum'),
    status: attachmentStatus('status').notNull().default('pending'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    uploadedByCustomerId: uuid('uploaded_by_customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    uploadedAt: instant('uploaded_at'),
    ...timestamps,
  },
  (table) => [
    index('attachments_ticket_idx').on(table.ticketId),
    index('attachments_message_idx').on(table.messageId),
    index('attachments_status_idx').on(table.status),
  ],
);

export type AttachmentRow = typeof attachments.$inferSelect;
export type AttachmentStatus = (typeof attachmentStatus.enumValues)[number];
