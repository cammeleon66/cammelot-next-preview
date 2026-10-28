// Building selection UI. Reads snapshots, never mutates them or any simulation state.
// Snapshot contract (additive): snapshot.buildings = [{ id, state, hours?, numbers: [{ label, value, unit? }] }]
// with state 'open' | 'closed' (outside opening hours) | 'construction'.
import { project, toScreen } from '../render/iso.js';
import { hitTestScreen } from '../render/hit.js';
import { describeGpPractice } from './gp-practice.js';

export const MAX_TOOLTIP_NUMBERS = 3;
const STATE_LABELS = Object.freeze({
  open: 'Open', closed: 'Closed · outside opening hours', construction: 'Under construction'
});

// Selectable buildings are those the snapshot describes, in world (= Tab) order.
export function selectableBuildings(world, snapshot) {
  const ids = new Set((snapshot?.buildings ?? []).map(entry => entry.id));
  return world.buildings.filter(b => ids.has(b.id));
}

export function describeBuilding(world, snapshot, id) {
  const base = world.buildings.find(b => b.id === id), entry = snapshot?.buildings?.find(b => b.id === id);
  if (!base || !entry) return null;
  const state = Object.hasOwn(STATE_LABELS, entry.state) ? entry.state : 'unknown';
  const format = n => `${n.label}: ${n.value}${n.unit ? ` ${n.unit}` : ''}`;
  return { id, name: base.name ?? base.id, state, stateLabel: STATE_LABELS[state] ?? 'Status unknown',
    hours: entry.hours ?? null,
    numbers: (entry.numbers ?? []).slice(0, MAX_TOOLTIP_NUMBERS).map(format) };
}

export function createBuildingUI({ canvas, city, world, root, panel, tooltip, snapshot }) {
  let current = snapshot, hovered = null, focused = null, selected = null, opener = null;
  const html = Object.assign;
  const list = html(document.createElement('ul'), { className: 'building-list' });
  root.append(list);
  const panelTitle = panel.querySelector('[data-panel-title]'), panelBody = panel.querySelector('[data-panel-body]');
  const describe = id => describeBuilding(world, current, id);
  const activeId = () => hovered ?? focused;

  function buttons() {
    const wanted = selectableBuildings(world, current);
    if (list.children.length !== wanted.length || wanted.some((b, i) => list.children[i].dataset.id !== b.id)) {
      list.replaceChildren(...wanted.map(b => {
        const li = document.createElement('li'), button = html(document.createElement('button'), { type: 'button' });
        li.dataset.id = button.dataset.id = b.id; button.setAttribute('aria-describedby', tooltip.id);
        button.onfocus = () => { focused = b.id; refresh(); };
        button.onblur = () => { if (focused === b.id) focused = null; refresh(); };
        button.onmouseenter = () => { hovered = b.id; refresh(); };
        button.onmouseleave = () => { if (hovered === b.id) hovered = null; refresh(); };
        button.onclick = () => open(b.id, button);
        li.append(button); return li;
      }));
    }
    for (const button of list.querySelectorAll('button')) {
      const info = describe(button.dataset.id);
      button.textContent = `${info.name} — ${info.stateLabel}`;
      button.dataset.state = info.state;
    }
  }
  function placeTooltip(id) {
    const b = world.buildings.find(x => x.id === id), rect = canvas.getBoundingClientRect(), host = tooltip.offsetParent;
    const p = toScreen(project(b.x + b.w / 2, b.y + b.d / 2, b.height), city.camera);
    const hostRect = host ? host.getBoundingClientRect() : rect, k = rect.width / canvas.width || 1;
    const half = tooltip.offsetWidth / 2, x = rect.left - hostRect.left + p.x * k;
    tooltip.style.left = `${Math.round(Math.max(half, Math.min(hostRect.width - half, x)))}px`;
    tooltip.style.top = `${Math.round(rect.top - hostRect.top + p.y * k)}px`;
  }
  function refresh() {
    buttons();
    if (panel.open && selected) fillPanel(selected); // keep an open panel in step with the snapshot
    const id = activeId(), info = id && describe(id);
    if (!info) { tooltip.hidden = true; tooltip.replaceChildren(); return; }
    const name = html(document.createElement('strong'), { textContent: info.name });
    const state = html(document.createElement('span'), { textContent: info.stateLabel });
    const numbers = html(document.createElement('ul'));
    numbers.append(...info.numbers.map(text => html(document.createElement('li'), { textContent: text })));
    tooltip.replaceChildren(name, state, numbers);
    tooltip.hidden = false; placeTooltip(id);
  }
  function fillPanel(id) {
    const info = describe(id); if (!info) return;
    panelTitle.textContent = info.name;
    const gpRows = id === 'gp' ? describeGpPractice(current).map(({ key, label, value }) => [label, value, key]) : [];
    const rows = [['Status', info.stateLabel], ...(info.hours ? [['Opening hours', info.hours]] : []),
      ...info.numbers.map(text => text.split(': ')), ...gpRows];
    panelBody.replaceChildren(...rows.flatMap(([term, value, key]) => {
      const dt = html(document.createElement('dt'), { textContent: term });
      const dd = html(document.createElement('dd'), { textContent: value });
      if (key) {
        dt.dataset.metric = dd.dataset.metric = key;
        if (key === 'gpReferralCompleteness') dt.dataset.xrayLink = dd.dataset.xrayLink = 'referral-completeness';
      }
      return [dt, dd];
    }));
  }
  function open(id, from = document.activeElement) {
    if (!describe(id)) return;
    selected = id; opener = from; fillPanel(id);
    if (!panel.open) panel.showModal();
    refresh();
  }
  panel.addEventListener('close', () => {
    selected = null; refresh();
    if (opener?.isConnected && opener !== document.body) opener.focus(); else canvas.focus();
  });
  panel.querySelector('[data-panel-close]').onclick = () => panel.close();

  // Pointer: client coordinates -> canvas pixels -> projected space.
  const pick = event => {
    const rect = canvas.getBoundingClientRect(), k = canvas.width / rect.width;
    return hitTestScreen(selectableBuildings(world, current),
      { x: (event.clientX - rect.left) * k, y: (event.clientY - rect.top) * k }, city.camera)?.id ?? null;
  };
  canvas.addEventListener('pointermove', event => {
    if (event.buttons) return; // dragging pans; don't flicker tooltips
    const id = pick(event); if (id !== hovered) { hovered = id; canvas.style.cursor = id ? 'pointer' : ''; refresh(); }
  });
  canvas.addEventListener('pointerleave', () => { hovered = null; refresh(); });
  // A press-and-release without panning is a click; real drags keep panning the camera.
  let down = null;
  canvas.addEventListener('pointerdown', event => { down = { x: event.clientX, y: event.clientY }; });
  canvas.addEventListener('pointerup', event => {
    const id = down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 4 ? pick(event) : null;
    down = null; if (id) open(id, canvas);
  });

  refresh();
  return {
    pick, open, close: () => panel.close(),
    // Selection state for the renderer; changes only this module's view state.
    get view() { return { hover: activeId(), selected }; },
    get snapshot() { return current; },
    // Called every frame: adopts a new snapshot and keeps the tooltip anchored while the camera moves.
    setSnapshot(next) { if (next !== current) { current = next; refresh(); } else if (!tooltip.hidden) placeTooltip(activeId()); },
    refresh
  };
}
