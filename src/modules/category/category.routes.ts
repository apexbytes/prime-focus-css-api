import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from './category.controller.js';
import {
  categoryIdParams,
  createCategoryBody,
  listCategoriesQuery,
  updateCategoryBody,
} from './category.schema.js';

export const categoryRouter: Router = Router();

categoryRouter.use(authenticate);

// Reading the taxonomy is part of doing the job, so ticket:read is enough;
// changing it is a configuration action.
categoryRouter.get(
  '/',
  requirePermission('ticket:read'),
  validate({ query: listCategoriesQuery }),
  listCategories,
);
categoryRouter.post(
  '/',
  requirePermission('product:manage'),
  validate({ body: createCategoryBody }),
  createCategory,
);
categoryRouter.patch(
  '/:id',
  requirePermission('product:manage'),
  validate({ params: categoryIdParams, body: updateCategoryBody }),
  updateCategory,
);
categoryRouter.delete(
  '/:id',
  requirePermission('product:manage'),
  validate({ params: categoryIdParams }),
  deleteCategory,
);
