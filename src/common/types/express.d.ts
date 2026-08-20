declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request; always set by the correlationId middleware. */
      requestId: string;
      /** High-resolution start time in ms, used for duration logging. */
      startedAt: number;
    }
  }
}

export {};
