import { z } from 'zod';

export const startSessionBody = z.object({
  /**
   * The product code the widget was embedded for. A code rather than an id: the
   * value is pasted into a page's markup by whoever installs the widget, and a
   * uuid there is a support call waiting to happen.
   */
  productCode: z.string().min(1).max(64).optional(),
  displayName: z.string().min(1).max(120).optional(),
  /** Volunteered contact detail, never treated as identity — see the service. */
  contactEmail: z.email().max(320).optional(),
  /** Which page the widget was opened on, for the agent's context. */
  page: z.string().max(2048).optional(),
});

export const sendMessageBody = z.object({
  body: z.string().min(1).max(4000),
});
