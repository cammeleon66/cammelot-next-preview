const formatCount = value => Number.isFinite(value) ? String(value) : 'n/a';
const formatPercent = value => Number.isFinite(value) ? `${Number((value * 100).toFixed(1))}%` : 'n/a';

// Maps the contract's generic metrics record to the GP panel's display rows.
export function describeGpPractice(snapshot) {
  const metrics = snapshot?.metrics ?? {};
  return [
    { key: 'gpSessionsPerDay', label: 'Sessions per day', value: formatCount(metrics.gpSessionsPerDay) },
    { key: 'gpAppointmentBacklog', label: 'Appointment backlog', value: formatCount(metrics.gpAppointmentBacklog) },
    { key: 'gpReferralRate', label: 'Referral rate', value: formatPercent(metrics.gpReferralRate) },
    { key: 'gpReferralCompleteness', label: 'Referral completeness · X-ray link',
      value: formatPercent(metrics.gpReferralCompleteness) }
  ];
}
