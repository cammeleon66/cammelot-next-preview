/**
 * @typedef {{ id: string, state: string, createdAt: number, location: object }} Patient
 * @typedef {{ id: string, patientId: string, createdAt: number, complete: boolean }} Referral
 * @typedef {{ id: string, role: string, fte: number, assignedArea: string|null }} StaffMember
 * @typedef {{ id: string, servers: number, rooms: number, equipment: number }} Area
 * @typedef {{ id: string, operatingBudget: number, attentionSlots: number }} Organisation
 */

/** @param {object} data @returns {Patient} */
export function createPatient(data) {
  throw new Error('NotImplemented: createPatient');
}

/** @param {object} data @returns {Referral} */
export function createReferral(data) {
  throw new Error('NotImplemented: createReferral');
}

/** @param {object} data @returns {StaffMember} */
export function createStaffMember(data) {
  throw new Error('NotImplemented: createStaffMember');
}

/** @param {object} data @returns {Area} */
export function createArea(data) {
  throw new Error('NotImplemented: createArea');
}

/** @param {object} data @returns {Organisation} */
export function createOrganisation(data) {
  throw new Error('NotImplemented: createOrganisation');
}
