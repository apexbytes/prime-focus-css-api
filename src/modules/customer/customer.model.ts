import { index, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { products } from '../product/product.model.js';

/** Drives SLA selection and routing priority. */
export const customerTier = pgEnum('customer_tier', ['standard', 'priority', 'vip']);

/**
 * People outside Prime Focus who raise queries. Deliberately credential-free:
 * customers never sign in (see Phase 2), they are identified by the address they
 * write from and by the account references their product systems supply.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Lower-cased at the validation boundary; the identity key for inbound mail.
     *
     * Nullable since Phase 8, and the reason is worth stating: a customer who
     * first reaches the desk over WhatsApp or the chat widget has a phone number
     * or a browser session and no address at all. The alternatives were both
     * worse than a nullable column. Synthesising `263771234567@whatsapp.invalid`
     * would put a fake address in the one field every outbound email path reads,
     * so a CSAT survey would be mailed into a black hole forever and nobody
     * would know. Refusing to record the customer would mean a WhatsApp
     * conversation with no customer on it.
     *
     * Postgres treats NULLs as distinct, so the unique constraint still holds
     * exactly the property it held before: at most one customer per address.
     * Every send path now asks whether there is an address instead of assuming
     * one — see `conversation.service.dispatchReply` and `survey.service`.
     */
    email: text('email').unique(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    /** ISO code; drives which language a reply template is rendered in. */
    language: text('language').notNull().default('en'),
    tier: customerTier('tier').notNull().default('standard'),
    /** Ids in other Prime Focus systems, keyed by system name. */
    externalRefs: jsonb('external_refs'),
    notes: text('notes'),
    /** Set when merged into another record; points at the survivor. */
    mergedIntoCustomerId: uuid('merged_into_customer_id'),
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (table) => [
    index('customers_full_name_idx').on(table.fullName),
    index('customers_phone_idx').on(table.phone),
  ],
);

/** A customer's account within one product, as that product's system knows it. */
export const customerProductAccounts = pgTable(
  'customer_product_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    externalAccountId: text('external_account_id').notNull(),
    status: text('status'),
    ...timestamps,
  },
  (table) => [
    unique('customer_product_accounts_unique').on(
      table.customerId,
      table.productId,
      table.externalAccountId,
    ),
    index('customer_product_accounts_lookup_idx').on(table.productId, table.externalAccountId),
  ],
);

export type CustomerRow = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type CustomerTier = (typeof customerTier.enumValues)[number];
export type CustomerProductAccountRow = typeof customerProductAccounts.$inferSelect;
