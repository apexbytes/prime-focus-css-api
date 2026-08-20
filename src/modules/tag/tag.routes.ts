import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import { createTag, deleteTag, listTags } from './tag.controller.js';
import { createTagBody, tagIdParams } from './tag.schema.js';

export const tagRouter: Router = Router();

tagRouter.use(authenticate);

tagRouter.get('/', requirePermission('ticket:read'), listTags);
// Any agent who can reply may coin a tag; deleting one affects every ticket that
// carries it, so that needs the heavier permission.
tagRouter.post(
  '/',
  requirePermission('ticket:reply'),
  validate({ body: createTagBody }),
  createTag,
);
tagRouter.delete(
  '/:id',
  requirePermission('ticket:manage'),
  validate({ params: tagIdParams }),
  deleteTag,
);
