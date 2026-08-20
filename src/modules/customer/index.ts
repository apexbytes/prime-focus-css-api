export { customerRouter } from './customer.routes.js';
export {
  findByEmail,
  findOrCreateFromEmail,
  requireById as requireCustomerById,
} from './customer.service.js';
export type { CustomerRow } from './customer.types.js';
