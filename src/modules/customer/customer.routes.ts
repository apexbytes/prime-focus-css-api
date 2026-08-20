import { Router } from 'express';
import { idempotency, validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createCustomer,
  getCustomer,
  linkAccount,
  listCustomers,
  mergeCustomer,
  unlinkAccount,
  updateCustomer,
} from './customer.controller.js';
import {
  createCustomerBody,
  customerAccountParams,
  customerIdParams,
  linkAccountBody,
  listCustomersQuery,
  mergeCustomerBody,
  updateCustomerBody,
} from './customer.schema.js';

export const customerRouter: Router = Router();

customerRouter.use(authenticate);

customerRouter.get(
  '/',
  requirePermission('customer:read'),
  validate({ query: listCustomersQuery }),
  listCustomers,
);
customerRouter.post(
  '/',
  requirePermission('customer:manage'),
  idempotency(),
  validate({ body: createCustomerBody }),
  createCustomer,
);
customerRouter.get(
  '/:id',
  requirePermission('customer:read'),
  validate({ params: customerIdParams }),
  getCustomer,
);
customerRouter.patch(
  '/:id',
  requirePermission('customer:manage'),
  validate({ params: customerIdParams, body: updateCustomerBody }),
  updateCustomer,
);

customerRouter.post(
  '/:id/accounts',
  requirePermission('customer:manage'),
  validate({ params: customerIdParams, body: linkAccountBody }),
  linkAccount,
);
customerRouter.delete(
  '/:id/accounts/:accountId',
  requirePermission('customer:manage'),
  validate({ params: customerAccountParams }),
  unlinkAccount,
);

/** Irreversible: the duplicate is retired and its tickets move across. */
customerRouter.post(
  '/:id/merge',
  requirePermission('customer:manage'),
  validate({ params: customerIdParams, body: mergeCustomerBody }),
  mergeCustomer,
);
