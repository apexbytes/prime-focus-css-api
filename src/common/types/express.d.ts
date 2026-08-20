declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request; always set by the correlationId middleware. */
      requestId: string;
      /** High-resolution start time in ms, used for duration logging. */
      startedAt: number;
      /** Set by the authenticate middleware; absent on public routes. */
      actor?: import('./actor.js').Actor;
    }
  }
}

export {};
