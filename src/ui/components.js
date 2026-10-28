// Plain DOM factories. Copy is always text, never interpreted as HTML.
let sequence = 0;
const text = (tag, value) => Object.assign(document.createElement(tag), { textContent: value });
function titled(tag, className, title, children, level) {
  const element = document.createElement(tag);
  element.className = className;
  const heading = text(`h${level}`, title);
  heading.id = `cammelot-heading-${++sequence}`;
  element.setAttribute('aria-labelledby', heading.id);
  element.append(heading, ...children);
  return element;
}
export const Panel = ({ title, children = [] }) => titled('section', 'panel', title, children, 2);
export const Card = ({ title, children = [] }) => titled('article', 'card', title, children, 3);
export function Meter({ label, value, max = 100, status = '' }) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value < 0 || value > max) {
    throw new RangeError('Meter requires 0 ≤ value ≤ max and max > 0');
  }
  const wrapper = document.createElement('label');
  wrapper.className = 'meter';
  const meter = document.createElement('meter');
  Object.assign(meter, { min: 0, max, value });
  meter.setAttribute('aria-label', label);
  const summary = text('span', `${label}: ${value} / ${max}${status ? ` — ${status}` : ''}`);
  summary.className = 'number';
  wrapper.append(summary, meter);
  return wrapper;
}
export function Ticker({ message }) {
  const ticker = document.createElement('div');
  ticker.className = 'ticker';
  ticker.setAttribute('role', 'status');
  ticker.setAttribute('aria-atomic', 'true');
  ticker.append(text('p', message));
  return ticker; // Static by default: callers update text only for meaningful events.
}
export function Gazette({ headline, story, edition = 'Synthetic style-guide edition' }) {
  const paper = titled('article', 'gazette', 'The Cammelot Gazette', [], 2);
  const date = text('p', edition);
  date.className = 'edition';
  paper.append(date, text('h3', headline), text('p', story));
  return paper;
}
export function openDialog(dialog, trigger) {
  if (dialog.open) return;
  const previous = trigger ?? document.activeElement;
  dialog.addEventListener('close', () => {
    if (previous?.isConnected) previous.focus();
  }, { once: true });
  dialog.showModal(); // Native focus trap, inert background, Escape and autofocus.
}
