# Synthetic multi-seed experiment report

> SYNTHETIC OUTPUT - modelled queues for a fictional cohort, not a clinical or national prediction

Scenario: `chapter0@0.1.0` · schema 1 · SHA-256 `aebdbdcd41de0b4d08ff4665891489ea74f536fd20aed0cd7cefb54abc64638e`
Engine: `0.4.0` · 4 quarter(s) · seeds: 17, 53, 89

Results describe this synthetic scenario only; they are not clinical, national, or causal claims.
Strategies and sensitivity variants use matched seeds and named exogenous streams. Changing an exogenous parameter can change its realized trace.
Sensitivity changes are smoke tests; no universal direction is asserted.

| Strategy | Median referral-to-treatment (min) | Median treatment starts | Median diagnostics queue |
|---|---:|---:|---:|
| Baseline | 90722 | 1144 | 4 |
| Higher referral completeness (synthetic what-if) | 92268 | 1129 | 4 |
| Two outpatient server seats (synthetic what-if) | 7202 | 2197 | 305 |

## ±20% sensitivity smoke

| Parameter | Change | Paired median Δ referral-to-treatment (min) | Paired Δ range (min) |
|---|---:|---:|---:|
| `parameters.arrivalsPerWeek` | -20% | -17344 | -21741 to -6755.5 |
| `parameters.arrivalsPerWeek` | +20% | 198 | -5105.5 to 4015 |
| `parameters.pReferral` | -20% | -25951.5 | -27038 to -6855.5 |
| `parameters.pReferral` | +20% | -1279 | -3731 to 5043.5 |
| `parameters.pDiagnostics` | -20% | -3297 | -8430 to 2354 |
| `parameters.pDiagnostics` | +20% | -1124 | -1227 to 1458 |
| `areas.outpatient.serviceTime.mean` | -20% | -13126.5 | -13936 to -3735 |
| `areas.outpatient.serviceTime.mean` | +20% | 1855 | -3991 to 4074 |
| `infrastructure.gp_to_hospital.completeness` | -20% | 1046 | -80 to 1392.5 |
| `infrastructure.gp_to_hospital.completeness` | +20% | -277 | -3790 to 193 |

Paired deltas are model outputs under shared seeds; interpret them as a reproducibility check, not as evidence about real care.
