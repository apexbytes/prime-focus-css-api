export { productRouter } from './product.routes.js';
export {
  assertAccess,
  findByCode,
  findBySupportEmail,
  requireById as requireProductById,
  scopeFor,
} from './product.service.js';
export type { ProductRow, ProductScope } from './product.types.js';
