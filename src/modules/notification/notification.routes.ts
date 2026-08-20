import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requireUserActor } from '../auth/auth.middleware.js';
import {
  getPreferences,
  listNotifications,
  markAllRead,
  markRead,
  updatePreferences,
} from './notification.controller.js';
import {
  listNotificationsQuery,
  notificationIdParams,
  updatePreferencesBody,
} from './notification.schema.js';

/**
 * No permissions here: a notification belongs to exactly one agent, and the
 * controller scopes every query to the caller. There is deliberately no way to
 * read someone else's.
 */
export const notificationRouter: Router = Router();

notificationRouter.use(authenticate, requireUserActor);

notificationRouter.get('/', validate({ query: listNotificationsQuery }), listNotifications);
notificationRouter.post('/read-all', markAllRead);
notificationRouter.patch('/:id/read', validate({ params: notificationIdParams }), markRead);

notificationRouter.get('/preferences', getPreferences);
notificationRouter.put(
  '/preferences',
  validate({ body: updatePreferencesBody }),
  updatePreferences,
);
