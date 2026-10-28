/**
 * Double-entry funding ledger (SIMULATION_SPEC §9). Amounts are whole euros (safe integers), so
 * the ledger identity is exact. Every entry moves `amount` from a credit account to a debit
 * account: opening funds debit `source:<id>` / credit `opening:<id>`; a cost debits
 * `expense:<category>` / credits `source:<id>`. Rejected costs never post.
 *
 * @typedef {{ id: string, label: string, amount: number, eligibleCostTypes: readonly string[],
 *   recurringAllowed: boolean, eligibleInterventionTypes?: readonly string[] }} FundingSource
 * @typedef {{ sequence: number, time: number, debit: string, credit: string, amount: number,
 *   sourceId?: string, category?: string, interventionType?: string, decisionId?: string|number, interventionId?: string }} LedgerEntry
 * @typedef {{ sources: Map<string, FundingSource>, balances: Map<string, number>, entries: LedgerEntry[],
 *   shortfalls: object[] }} FundingLedger
 */

export const COST_CATEGORIES = Object.freeze([
  "capital",
  "one_off_implementation",
  "recurring_staff",
  "recurring_licence",
  "recurring_maintenance",
]);
const isWholeEuros = (value) => Number.isSafeInteger(value) && value >= 0;
export const isRecurringCategory = (category) => category.startsWith("recurring_");

/**
 * Why `cost` may not be paid from `source` (eligibility only, not balance), or null if eligible.
 * Pure; shared by the ledger and decision-card previews.
 * @param {FundingSource|undefined} source
 * @param {{ category: string }} cost
 * @param {string} [interventionType]
 */
export function costIssue(source, cost, interventionType) {
  if (source === undefined) return "UNKNOWN_SOURCE";
  if (!COST_CATEGORIES.includes(cost.category)) return "UNKNOWN_COST_CATEGORY";
  if (!source.eligibleCostTypes.includes(cost.category)) return "INELIGIBLE_COST_CATEGORY";
  if (isRecurringCategory(cost.category) && !source.recurringAllowed) return "RECURRING_NOT_ALLOWED";
  if (source.eligibleInterventionTypes !== undefined && !source.eligibleInterventionTypes.includes(interventionType)) {
    return "INELIGIBLE_INTERVENTION_TYPE";
  }
  return null;
}

function post(ledger, fields) {
  const entry = Object.freeze({ sequence: ledger.entries.length, ...fields });
  ledger.entries.push(entry);
  for (const [account, delta] of [[entry.debit, entry.amount], [entry.credit, -entry.amount]]) {
    ledger.balances.set(account, (ledger.balances.get(account) ?? 0) + delta);
  }
  return entry;
}

/** @param {readonly object[]} sources @returns {FundingLedger} */
export function createFundingLedger(sources = []) {
  if (!Array.isArray(sources)) throw new TypeError("funding sources must be an array");
  const ledger = { sources: new Map(), balances: new Map(), entries: [], shortfalls: [] };
  for (const [index, data] of sources.entries()) {
    const label = `fundingSources[${index}]`;
    if (typeof data?.id !== "string" || data.id.length === 0) throw new TypeError(`${label}.id must be a non-empty string`);
    if (ledger.sources.has(data.id)) throw new Error(`duplicate funding source ${data.id}`);
    if (!isWholeEuros(data.amount)) throw new RangeError(`${label}.amount must be a non-negative safe integer (EUR)`);
    if (!Array.isArray(data.eligibleCostTypes) || !data.eligibleCostTypes.every((c) => COST_CATEGORIES.includes(c))) {
      throw new RangeError(`${label}.eligibleCostTypes must list known cost categories`);
    }
    if (typeof data.recurringAllowed !== "boolean") throw new TypeError(`${label}.recurringAllowed must be a boolean`);
    if (data.eligibleInterventionTypes !== undefined && !Array.isArray(data.eligibleInterventionTypes)) {
      throw new TypeError(`${label}.eligibleInterventionTypes must be an array when present`);
    }
    const source = Object.freeze({
      id: data.id,
      label: typeof data.label === "string" ? data.label : data.id,
      amount: data.amount,
      eligibleCostTypes: Object.freeze([...data.eligibleCostTypes]),
      recurringAllowed: data.recurringAllowed,
      ...(data.eligibleInterventionTypes && { eligibleInterventionTypes: Object.freeze([...data.eligibleInterventionTypes]) }),
    });
    ledger.sources.set(source.id, source);
    post(ledger, { time: 0, debit: `source:${source.id}`, credit: `opening:${source.id}`, amount: source.amount });
  }
  return ledger;
}

export const balanceOf = (ledger, sourceId) => ledger.balances.get(`source:${sourceId}`) ?? 0;

/**
 * First reason the costs cannot all be paid (eligibility, then cumulative balance per source), or
 * null. Checking a batch first lets a multi-source decision post atomically.
 * @param {FundingLedger} ledger
 * @param {readonly { sourceId: string, amount: number, category: string, interventionType?: string }[]} costs
 */
export function checkCosts(ledger, costs) {
  const pending = new Map();
  for (const cost of costs) {
    if (!isWholeEuros(cost.amount) || cost.amount === 0) return "INVALID_COST";
    const issue = costIssue(ledger.sources.get(cost.sourceId), cost, cost.interventionType);
    if (issue !== null) return issue;
    const total = (pending.get(cost.sourceId) ?? 0) + cost.amount;
    if (total > balanceOf(ledger, cost.sourceId)) return "INSUFFICIENT_FUNDS";
    pending.set(cost.sourceId, total);
  }
  return null;
}

/**
 * Post one cost. Rejected costs leave the ledger untouched.
 * @param {FundingLedger} ledger
 * @param {{ sourceId: string, amount: number, category: string, time: number, interventionType?: string,
 *   interventionId?: string, decisionId?: string|number }} entry
 * @returns {{ ok: true, entry: LedgerEntry }|{ ok: false, reasonCode: string }}
 */
export function postCost(ledger, entry) {
  if (!Number.isSafeInteger(entry?.time) || entry.time < 0) return { ok: false, reasonCode: "INVALID_COST" };
  const reasonCode = checkCosts(ledger, [entry]);
  if (reasonCode !== null) return { ok: false, reasonCode };
  const { sourceId, amount, category, time, interventionType, interventionId, decisionId } = entry;
  return {
    ok: true,
    entry: post(ledger, {
      time, debit: `expense:${category}`, credit: `source:${sourceId}`, amount, sourceId, category,
      ...(interventionType !== undefined && { interventionType }),
      ...(interventionId !== undefined && { interventionId }),
      ...(decisionId !== undefined && { decisionId }),
    }),
  };
}

/**
 * Ledger invariant: entries are well-formed and eligible, no source is overdrawn, and
 * sum(source balances) + sum(expenses) = sum(initial funds) + sum(inflows).
 * @param {FundingLedger} ledger
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateLedger(ledger) {
  const errors = [];
  const totals = { opening: 0, inflow: 0, source: 0, expense: 0 };
  const recomputed = new Map();
  for (const entry of ledger.entries) {
    if (!isWholeEuros(entry.amount) || entry.debit === entry.credit) errors.push(`entry ${entry.sequence} is malformed`);
    if (entry.debit.startsWith("expense:") && costIssue(ledger.sources.get(entry.sourceId), entry, entry.interventionType) !== null) {
      errors.push(`entry ${entry.sequence} posts an ineligible ${entry.category} cost to ${entry.sourceId}`);
    }
    recomputed.set(entry.debit, (recomputed.get(entry.debit) ?? 0) + entry.amount);
    recomputed.set(entry.credit, (recomputed.get(entry.credit) ?? 0) - entry.amount);
  }
  for (const [account, balance] of recomputed) {
    if (ledger.balances.get(account) !== balance) errors.push(`account ${account} balance does not match its entries`);
    const kind = account.slice(0, account.indexOf(":"));
    if (kind === "opening" || kind === "inflow") totals[kind] -= balance;
    else if (kind in totals) totals[kind] += balance;
    if (kind === "source" && balance < 0) errors.push(`${account} is overdrawn`);
  }
  if (totals.source + totals.expense !== totals.opening + totals.inflow) {
    errors.push("ledger identity failed: balances + expenses must equal initial funds + inflows");
  }
  return { ok: errors.length === 0, errors };
}

/** Plain per-source summary for snapshots. */
export function summarizeLedger(ledger) {
  const spent = new Map();
  for (const entry of ledger.entries) {
    if (entry.sourceId !== undefined) spent.set(entry.sourceId, (spent.get(entry.sourceId) ?? 0) + entry.amount);
  }
  return {
    sources: [...ledger.sources.values()].map((source) => ({
      id: source.id,
      label: source.label,
      initial: source.amount,
      balance: balanceOf(ledger, source.id),
      spent: spent.get(source.id) ?? 0,
      eligibleCostTypes: [...source.eligibleCostTypes],
      recurringAllowed: source.recurringAllowed,
      ...(source.eligibleInterventionTypes && { eligibleInterventionTypes: [...source.eligibleInterventionTypes] }),
    })),
    shortfallEur: ledger.shortfalls.reduce((total, shortfall) => total + shortfall.amount, 0),
  };
}
