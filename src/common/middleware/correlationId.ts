import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { MAX_REQUEST_ID_LENGTH, REQUEST_ID_HEADER } from '../../config/index.js';
import { runWithContext } from '../context/request-context.js';

/** Only accept an inbound id that is safe to echo into logs and headers. */
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * First middleware in the chain. Establishes the correlation id for the request
 * and opens the AsyncLocalStorage scope that the logger reads from, so every
 * downstream log line — including ones emitted from queued jobs enqueued here —
 * can be traced back to this request.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get(REQUEST_ID_HEADER);
  const requestId =
    inbound && inbound.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(inbound)
      ? inbound
      : uuidv7();

  req.requestId = requestId;
  req.startedAt = performance.now();
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithContext({ requestId, method: req.method, path: req.path }, () => {
    next();
  });
}
