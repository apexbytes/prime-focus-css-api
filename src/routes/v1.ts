import { Router } from 'express';
import { API_PREFIX, env, SERVICE_NAME } from '../config/index.js';
import { sendSuccess } from '../common/utils/response.js';
import { apiKeyRouter } from '../modules/api-key/index.js';
import { attachmentItemRouter } from '../modules/attachment/index.js';
import { auditRouter } from '../modules/audit/index.js';
import { authRouter } from '../modules/auth/index.js';
import { categoryRouter } from '../modules/category/index.js';
import { customerRouter } from '../modules/customer/index.js';
import { emailAdminRouter } from '../modules/email/index.js';
import { escalationRuleRouter } from '../modules/escalation/index.js';
import { invitationRouter } from '../modules/invitation/index.js';
import { kbRouter } from '../modules/knowledge-base/index.js';
import { macroRouter } from '../modules/macro/index.js';
import { trustedDeviceRouter } from '../modules/mfa/index.js';
import { notificationRouter } from '../modules/notification/index.js';
import { productRouter } from '../modules/product/index.js';
import { reportRouter } from '../modules/report/index.js';
import { retentionRouter } from '../modules/retention/index.js';
import { routingRuleRouter } from '../modules/routing/index.js';
import { permissionRouter, roleRouter } from '../modules/role/index.js';
import { businessHoursRouter, slaPolicyRouter, slaRouter } from '../modules/sla/index.js';
import { csatRouter, surveyPublicRouter } from '../modules/survey/index.js';
import { tagRouter } from '../modules/tag/index.js';
import { teamRouter } from '../modules/team/index.js';
import { ticketRouter } from '../modules/ticket/index.js';
import { userRouter } from '../modules/user/index.js';

const MODULES = [
  'auth',
  'invitations',
  'users',
  'roles',
  'permissions',
  'teams',
  'api-keys',
  'audit-logs',
  'products',
  'customers',
  'categories',
  'tags',
  'tickets',
  'attachments',
  'macros',
  'notifications',
  'sla-policies',
  'business-hours',
  'routing-rules',
  'escalation-rules',
  'kb',
  'surveys',
  'csat',
  'reports',
  'retention',
] as const;

/**
 * Every module router mounts here. Adding a module means one import and one
 * `use()` — nothing else in the app wiring changes.
 *
 * The inbound email webhooks are the exception: they mount in app.ts ahead of
 * the rate limiter, because they are authenticated by signature and a spike of
 * customer email must not be throttled.
 */
export const v1Router: Router = Router();

v1Router.get('/', (_req, res) => {
  sendSuccess(res, {
    service: SERVICE_NAME,
    version: env.APP_VERSION,
    apiVersion: 'v1',
    basePath: API_PREFIX,
    modules: [...MODULES],
  });
});

// -- identity & access --------------------------------------------------------
// Mounted before '/auth' so the more specific path is matched first.
v1Router.use('/auth/devices', trustedDeviceRouter);
v1Router.use('/auth', authRouter);
v1Router.use('/invitations', invitationRouter);
v1Router.use('/users', userRouter);
v1Router.use('/roles', roleRouter);
v1Router.use('/permissions', permissionRouter);
v1Router.use('/teams', teamRouter);
v1Router.use('/api-keys', apiKeyRouter);
v1Router.use('/audit-logs', auditRouter);

// -- products, customers & ticketing -----------------------------------------
v1Router.use('/products', productRouter);
v1Router.use('/customers', customerRouter);
v1Router.use('/categories', categoryRouter);
v1Router.use('/tags', tagRouter);
v1Router.use('/tickets', ticketRouter);
v1Router.use('/attachments', attachmentItemRouter);
v1Router.use('/macros', macroRouter);

// -- routing, service levels & escalation ------------------------------------
v1Router.use('/sla-policies', slaPolicyRouter);
v1Router.use('/business-hours', businessHoursRouter);
v1Router.use('/routing-rules', routingRuleRouter);
v1Router.use('/escalation-rules', escalationRuleRouter);
v1Router.use('/sla', slaRouter);
v1Router.use('/notifications', notificationRouter);
v1Router.use('/email', emailAdminRouter);

// -- deflection & insight -----------------------------------------------------
v1Router.use('/kb', kbRouter);
// Unauthenticated: the token in the emailed link is the credential. Kept apart
// from `/csat`, which is the staff read, so a token can never reach a staff
// endpoint by taking a wrong turn in the router.
v1Router.use('/surveys', surveyPublicRouter);
v1Router.use('/csat', csatRouter);
v1Router.use('/reports', reportRouter);
v1Router.use('/retention', retentionRouter);
