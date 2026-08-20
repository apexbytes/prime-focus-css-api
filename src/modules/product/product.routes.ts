import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createProduct,
  getProduct,
  grantProductAccess,
  listProducts,
  revokeProductAccess,
  updateProduct,
} from './product.controller.js';
import {
  createProductBody,
  grantAccessBody,
  listProductsQuery,
  productAgentParams,
  productIdParams,
  updateProductBody,
} from './product.schema.js';

export const productRouter: Router = Router();

productRouter.use(authenticate);

productRouter.get(
  '/',
  requirePermission('product:read'),
  validate({ query: listProductsQuery }),
  listProducts,
);
productRouter.post(
  '/',
  requirePermission('product:manage'),
  validate({ body: createProductBody }),
  createProduct,
);
productRouter.get(
  '/:id',
  requirePermission('product:read'),
  validate({ params: productIdParams }),
  getProduct,
);
productRouter.patch(
  '/:id',
  requirePermission('product:manage'),
  validate({ params: productIdParams, body: updateProductBody }),
  updateProduct,
);

/** Which agents may work this product. */
productRouter.post(
  '/:id/agents',
  requirePermission('product:manage'),
  validate({ params: productIdParams, body: grantAccessBody }),
  grantProductAccess,
);
productRouter.delete(
  '/:id/agents/:userId',
  requirePermission('product:manage'),
  validate({ params: productAgentParams }),
  revokeProductAccess,
);
