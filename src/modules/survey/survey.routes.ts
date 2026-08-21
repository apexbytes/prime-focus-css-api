import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import { getSurvey, getTicketSurvey, listSurveys, respondToSurvey } from './survey.controller.js';
import { listSurveysQuery, respondBody, tokenParams } from './survey.schema.js';

/**
 * Mounted at /surveys. **Unauthenticated by design**: the caller is a customer
 * who has no account in this system and never will — the token in the link is
 * the credential, and it grants exactly one thing, a score on one ticket.
 *
 * Left behind the global rate limiter, unlike the Resend webhooks: a flood of
 * survey requests is either a scanner or somebody guessing tokens, and neither
 * is traffic worth protecting.
 */
export const surveyPublicRouter: Router = Router();

surveyPublicRouter.get('/:token', validate({ params: tokenParams }), getSurvey);
surveyPublicRouter.post(
  '/:token',
  validate({ params: tokenParams, body: respondBody }),
  respondToSurvey,
);

/**
 * Mounted at /csat. Separate from the public router so no staff read can ever be
 * reached with a token in place of a session.
 */
export const csatRouter: Router = Router();

csatRouter.use(authenticate);
csatRouter.get(
  '/',
  requirePermission('report:view'),
  validate({ query: listSurveysQuery }),
  listSurveys,
);

/** Mounted at /tickets/:ticketId/survey. */
export const ticketSurveyRouter: Router = Router({ mergeParams: true });

ticketSurveyRouter.use(authenticate);
ticketSurveyRouter.get('/', requirePermission('ticket:read'), getTicketSurvey);
