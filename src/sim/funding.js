/**
 * @typedef {{ sources: Map<string, object>, entries: object[] }} FundingLedger
 */

/** @param {object[]} sources @returns {FundingLedger} */
export function createFundingLedger(sources) {
  throw new Error('NotImplemented: createFundingLedger');
}

/** @param {FundingLedger} ledger @param {object} entry */
export function postCost(ledger, entry) {
  throw new Error('NotImplemented: postCost');
}

/** @param {FundingLedger} ledger */
export function validateLedger(ledger) {
  throw new Error('NotImplemented: validateLedger');
}
