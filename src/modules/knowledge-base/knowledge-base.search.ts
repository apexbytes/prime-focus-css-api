/**
 * Turning free text into a Postgres text-search query.
 *
 * Pure and dependency-free so it can be unit tested without a database, which
 * matters because the two directions have opposite semantics and getting them
 * the wrong way round is silent: search returns nothing, or suggest returns
 * everything.
 */

/** Terms a suggestion query is built from before it stops being a signal. */
export const SUGGEST_TERM_LIMIT = 12;

/** Longest free text accepted; a pasted log file is not a search query. */
const MAX_QUERY_LENGTH = 512;

const MIN_TERM_LENGTH = 3;

/**
 * Words that carry no signal in a support corpus.
 *
 * Postgres's `english` configuration already drops true stop words from the
 * index, so these would match nothing anyway — the point of the list is that a
 * stop word must not consume one of the `SUGGEST_TERM_LIMIT` slots. The support
 * vocabulary at the end ("please", "help", "issue") is the expensive half: it
 * appears in almost every ticket and matches almost every article.
 */
const NOISE = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'him',
  'his',
  'how',
  'its',
  'may',
  'new',
  'now',
  'old',
  'see',
  'two',
  'who',
  'did',
  'yes',
  'that',
  'this',
  'with',
  'have',
  'from',
  'they',
  'been',
  'were',
  'said',
  'each',
  'she',
  'which',
  'their',
  'will',
  'about',
  'there',
  'would',
  'could',
  'should',
  'when',
  'what',
  'your',
  'into',
  'than',
  'then',
  'them',
  'these',
  'those',
  'only',
  'very',
  'just',
  'also',
  'been',
  'being',
  'does',
  'doing',
  'because',
  'while',
  'after',
  'before',
  'please',
  'kindly',
  'regards',
  'thanks',
  'thank',
  'hello',
  'dear',
  'sir',
  'madam',
  'morning',
  'afternoon',
  'help',
  'issue',
  'issues',
  'problem',
  'problems',
  'query',
  'queries',
  'question',
  'ticket',
  'support',
  'reference',
  'ref',
  'number',
  'account',
  'details',
  'information',
  'follow',
  'update',
  'status',
  'urgent',
  'asap',
  'still',
  'again',
  'need',
  'want',
  'trying',
  'tried',
  'unable',
  'cannot',
]);

/**
 * Sanitises a query the user typed for `websearch_to_tsquery`.
 *
 * `websearch_to_tsquery` is the only parser of the three that cannot throw on
 * arbitrary input — `to_tsquery` rejects unbalanced quotes and bare operators,
 * which a search box produces constantly — and it gives the user quoted phrases
 * and `-exclusions` for free. So the only work here is bounding the length and
 * refusing input with nothing searchable in it.
 *
 * Returns null when there is nothing to search for, which the caller must treat
 * as an empty result rather than as an unfiltered one.
 */
export function toSearchQuery(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_QUERY_LENGTH);
  if (!trimmed) return null;

  // Needs at least one word character; `"" -- ***` is not a query.
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : null;
}

/**
 * Builds a suggestion query out of a whole ticket.
 *
 * The semantics flip here. `websearch_to_tsquery` ANDs its terms, which is
 * right for a search box and useless for a ticket body: a customer's paragraph
 * ANDed together matches no article ever written. So the text is reduced to its
 * distinctive words and joined with `or`, and ranking — not matching — decides
 * what comes back.
 *
 * Returns null when nothing distinctive survives, which is the correct answer
 * for "hello please help": suggesting an arbitrary article to a customer who
 * gave us nothing to go on is worse than suggesting none.
 */
export function toSuggestQuery(input: {
  subject?: string | undefined;
  body?: string | undefined;
}): string | null {
  const terms = extractTerms(`${input.subject ?? ''} ${input.body ?? ''}`);
  return terms.length > 0 ? terms.join(' or ') : null;
}

/**
 * The distinctive words in a block of text, longest first, de-duplicated.
 *
 * Longest first because length correlates with specificity in this corpus:
 * "disbursement" is a better suggestion signal than "loan", and the term budget
 * should be spent on the former.
 */
export function extractTerms(text: string): string[] {
  const seen = new Set<string>();

  const words = text
    .toLowerCase()
    // Ticket references, addresses, URLs and long digit runs are identifiers,
    // not subject matter. Left in, a reference number would be the highest-
    // weighted term in the query and match nothing.
    .replace(/\b[a-z]{2,8}-\d{4}-\d{4,}\b/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/\d[\d\s.,+-]{3,}\d/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ');

  for (const word of words) {
    if (word.length < MIN_TERM_LENGTH) continue;
    if (NOISE.has(word)) continue;
    // A bare number is an amount or an account; neither identifies a topic.
    if (!/\p{L}/u.test(word)) continue;
    seen.add(word);
  }

  return [...seen].sort((left, right) => right.length - left.length).slice(0, SUGGEST_TERM_LIMIT);
}
