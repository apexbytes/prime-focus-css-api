/** The subset of Resend's `email.received` payload this system relies on. */
export interface InboundWebhookEvent {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    created_at: string;
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    received_for?: string[];
    message_id?: string;
    subject?: string;
    attachments?: {
      id: string;
      filename: string;
      content_type: string;
      content_disposition?: string;
      content_id?: string;
    }[];
  };
}

/** What the retrieval API returns once the full email is fetched. */
export interface FetchedInboundEmail {
  text: string | null;
  html: string | null;
  headers: Record<string, string> | null;
  subject: string | null;
  from: string | null;
}

export interface InboundProcessResult {
  status: 'processed' | 'ignored' | 'failed';
  ticketId?: string;
  ticketMessageId?: string;
  created?: boolean;
  reason?: string;
}
