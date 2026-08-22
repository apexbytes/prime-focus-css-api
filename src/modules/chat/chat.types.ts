/**
 * Room names on the chat namespace, in one place, for the reason
 * `realtime.types.ts` gives about the staff rooms: a typo in a room is silent —
 * the broadcast succeeds and nobody is in the room to hear it.
 *
 * One grain only, and that is the point. A visitor is in exactly one room, their
 * own conversation, and there is no room a visitor shares with anybody else. A
 * per-product room would be a way for one member of the public to receive
 * another's messages, so it does not exist to be joined by mistake.
 *
 * The room is keyed on the conversation's **external id** — the session's own
 * id, which is what the visitor's socket was authenticated as — rather than on
 * the conversation row's uuid. That way joining requires no database read on a
 * hot path, and a token that authenticates for one session cannot name another.
 */
export const CHAT_ROOM = {
  conversation: (externalId: string): string => `chat:${externalId}`,
} as const;

/** Events the server sends to a visitor. Client-sent names live in the gateway. */
export const CHAT_EVENT = {
  /** A message in this conversation, from either side. */
  message: 'chat:message',
  /** An agent started or stopped typing. */
  typing: 'chat:typing',
  /** The ticket behind this conversation changed state — resolved, mostly. */
  status: 'chat:status',
  /** The session is over: expired, or the desk closed the conversation. */
  ended: 'chat:ended',
} as const;

/**
 * What a visitor's socket is, once the handshake has checked their token.
 *
 * Deliberately *not* an `Actor`. An actor in this system is a member of staff, a
 * product system's API key or the system itself, and every authorisation check
 * in the codebase takes one. A visitor is none of those and must never be
 * assignable to one: the type is the reason a visitor cannot be passed to
 * `ticketService.requireAccessible` by accident.
 */
export interface ChatVisitor {
  kind: 'chat_visitor';
  sessionId: string;
  /** The conversation's external id, which is also this visitor's room. */
  conversationExternalId: string;
  productId: string;
  customerId: string;
  displayName: string;
}

/** What `POST /chat/sessions` hands the widget. */
export interface StartedChatSession {
  /** Bearer credential for the socket handshake and the REST fallback. */
  sessionToken: string;
  conversationExternalId: string;
  expiresAt: Date;
  namespace: string;
  path: string;
  productId: string;
  /** Whether a ticket exists yet — it does not until the first message. */
  ticketReference: string | null;
}

/** One entry of the transcript a returning visitor reads. */
export interface ChatTranscriptEntry {
  author: 'customer' | 'agent' | 'system';
  body: string;
  createdAt: Date;
}
