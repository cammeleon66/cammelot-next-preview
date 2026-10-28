// Decision cards (GAME_DESIGN_V2 §2/§11): cost by funding source, delay and mechanism — never a
// predicted outcome. `describeDecisionCards` is pure (Snapshot + scenario in, plain rows out);
// `renderDecisionCards` builds accessible DOM from those rows. Copy is text, never HTML.
import { costIssue, isRecurringCategory } from '../sim/funding.js';
import { resolveVariant } from '../sim/interventions.js';
import { Card } from './components.js';

const euro = amount => `€${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const CATEGORY = { capital: 'capital', one_off_implementation: 'one-off implementation', recurring_staff: 'recurring staff',
  recurring_licence: 'recurring licence', recurring_maintenance: 'recurring maintenance' };
export const REASONS = Object.freeze({
  INSUFFICIENT_FUNDS: 'Not enough money left in the funding source',
  INELIGIBLE_COST_CATEGORY: 'The funding source cannot pay this kind of cost',
  RECURRING_NOT_ALLOWED: 'The funding source cannot pay recurring costs',
  INELIGIBLE_INTERVENTION_TYPE: 'The funding source is earmarked for other intervention types',
  UNKNOWN_SOURCE: 'The funding source does not exist in this scenario',
  ALREADY_COMMITTED: 'Already committed in this run',
  INSUFFICIENT_CAPACITY: 'There is no staffed seat left to move',
  INVALID_INTERVENTION: 'This card does not fit the scenario set-up',
});
const reasonText = code => REASONS[code] ?? code;

function describeEffect(effect, scenario) {
  const [kind, id] = effect.target.split(/:(.*)/s);
  const label = kind === 'area' ? scenario.initialState.areas.find(a => String(a.id) === id)?.label ?? id : `${id} information edge`;
  const change = effect.op === 'set' ? `→ ${effect.param === 'completeness' ? `${Math.round(effect.value * 100)}%` : effect.value}`
    : effect.op === 'add' ? `${effect.value >= 0 ? '+' : '−'}${Math.abs(effect.value)}` : `×${effect.value}`;
  return `${label} · ${effect.param} ${change}`;
}

/** Card rows for every scenario intervention, using live Snapshot balances. */
export function describeDecisionCards(scenario, snapshot) {
  const sources = new Map((snapshot?.funding?.sources ?? []).map(source => [source.id, source]));
  const delay = scenario.parameters.recruitmentDelayQuarters?.value ?? { min: 1, max: 2 };
  const success = scenario.parameters.recruitmentSuccessProbability?.value ?? delay.probability ?? 0.7;
  const servers = new Map((snapshot?.resources ?? []).map(r => [`area:${r.areaId}`, r.capacity]));
  return (scenario.interventions ?? []).map(definition => {
    const committed = (snapshot?.interventions ?? []).filter(item => item.interventionId === definition.id);
    const variants = definition.variants?.length ? definition.variants.map(v => v.id) : [undefined];
    const options = variants.map(variantId => {
      const option = resolveVariant(definition, variantId);
      const pending = new Map();
      const costs = option.costs.map(cost => {
        const source = sources.get(cost.sourceId), recurring = isRecurringCategory(cost.category);
        let issue = costIssue(source, cost, option.type);
        if (issue === null && !recurring) {
          pending.set(cost.sourceId, (pending.get(cost.sourceId) ?? 0) + cost.amount);
          if (pending.get(cost.sourceId) > source.balance) issue = 'INSUFFICIENT_FUNDS';
        }
        return { sourceId: cost.sourceId, source: source?.label ?? cost.sourceId, balance: source?.balance ?? 0, issue,
          text: `${euro(cost.amount)} ${recurring ? 'per quarter, from when it takes effect' : 'one-off, paid now'} · ${CATEGORY[cost.category] ?? cost.category}` };
      });
      const delays = [];
      if (option.effects.some(e => (e.phase ?? 'implementation') === 'implementation')) {
        delays.push(option.implementationDelayDays === 0 ? 'Takes effect the next simulated day'
          : `${option.implementationDelayDays} days before it takes effect`);
        if (option.adoption.rampDays > 0) delays.push(`then adoption ramps over ${option.adoption.rampDays} days`);
      }
      if (option.effects.some(e => e.phase === 'recruitment')) {
        delays.push(`Recruitment takes ${delay.min}–${delay.max} quarters and fails ${Math.round((1 - success) * 100)}% of the time (nothing is paid if it fails)`);
      }
      const short = option.effects.find(e => e.op === 'add' && e.value < 0 && (servers.get(e.target) ?? 0) + e.value < 0);
      const blocked = definition.preconditions?.includes('once') && committed.length > 0 ? 'ALREADY_COMMITTED'
        : short ? 'INSUFFICIENT_CAPACITY' : costs.find(c => c.issue)?.issue ?? null;
      return { variant: variantId ?? null, label: option.label ?? definition.title, mechanism: option.mechanism ?? '',
        effects: option.effects.map(e => describeEffect(e, scenario)), costs, delay: delays.join('; '), blocked,
        blockedText: blocked && reasonText(blocked) };
    });
    const labelOf = variant => options.find(option => option.variant === variant)?.label ?? definition.title;
    const history = committed.map(item => `${labelOf(item.variant)}: ${item.phases.map(p => `${p.phase} ${p.status}`).join(', ')}`);
    return { id: definition.id, title: definition.title, type: definition.type, history, options };
  });
}

/** Accessible cards: each option has its mechanism, cost-by-source list, delay and a commit button. */
export function renderDecisionCards(root, cards, onCommit) {
  const make = (tag, text, className) => Object.assign(document.createElement(tag), { textContent: text, ...(className && { className }) });
  const focused = document.activeElement?.dataset?.decisionKey;
  root.replaceChildren(...cards.map(card => Card({ title: card.title, children: [...card.options.map(option => {
    const section = document.createElement('section');
    section.className = 'decision-option';
    const key = `${card.id}/${option.variant ?? ''}`;
    const mechanism = make('ul', ''); mechanism.setAttribute('aria-label', 'Mechanism changes');
    mechanism.append(...option.effects.map(text => make('li', text)));
    const costs = document.createElement('dl'); costs.setAttribute('aria-label', 'Cost by funding source');
    if (option.costs.length === 0) costs.append(make('dt', 'No funding cost'), make('dd', 'Uses existing staff instead'));
    for (const cost of option.costs) {
      costs.append(make('dt', cost.source), make('dd', `${cost.text} (balance ${euro(cost.balance)})${cost.issue ? ` — ${reasonText(cost.issue)}` : ''}`));
    }
    const button = make('button', `Commit: ${option.label}`);
    Object.assign(button, { type: 'button', disabled: option.blocked !== null });
    button.dataset.decisionKey = key;
    button.onclick = () => onCommit(card.id, option.variant, option.label);
    const children = [make('h4', option.label), make('p', option.mechanism), mechanism, costs, make('p', `Delay: ${option.delay}`)];
    if (option.blocked) {
      const reason = make('p', `Unavailable: ${option.blockedText}`, 'status');
      reason.id = `decision-reason-${card.id}-${option.variant ?? 'default'}`;
      button.setAttribute('aria-describedby', reason.id);
      children.push(reason);
    }
    section.append(...children, button);
    return section;
  }), ...(card.history.length ? [make('p', `In this run — ${card.history.join('; ')}`)] : [])] })));
  if (focused) root.querySelector(`[data-decision-key="${CSS.escape(focused)}"]`)?.focus();
}
