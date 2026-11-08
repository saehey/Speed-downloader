import type { DesktopApi, FileCheck } from '../shared/api.ts';
import { categoryOf, FOLDER_KINDS } from '../shared/categories.ts';
import type { Category, FolderKind } from '../shared/categories.ts';
import { MESSAGES } from '../shared/i18n.ts';
import type { Messages } from '../shared/i18n.ts';
import { withinWindow } from '../shared/schedule.ts';
import { startTracker } from '../shared/started.ts';
import { linkState } from '../shared/extension-link.ts';
import type { ExtensionStatus } from '../shared/extension-link.ts';
import type { ReliabilityStats } from '../shared/stats.ts';
import type { ApiState, DesktopInfo, Download, Language, ProblemKind } from '../shared/types.ts';

const api = (window as unknown as { api: DesktopApi }).api;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ICONS = {
  page: ['M3.5 2.5h12l5 5v14h-17z', 'M15.5 2.5v5h5'],
  pause: ['M9 6v12', 'M15 6v12'],
  play: ['M8 5.5v13l10-6.5z'],
  more: ['M12 5.5v.5', 'M12 12v.5', 'M12 18.5v.5'],
  open: ['M14 5h5v5', 'M19 5l-8 8', 'M17 14v5H5V7h5'],
  restart: ['M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9', 'M4.5 4.5V9H9'],
  remove: ['M5 7h14', 'M5 12h14', 'M5 17h8'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 12.5h9l1-12.5', 'M10 11v5', 'M14 11v5'],
  cancel: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
} satisfies Record<string, string[]>;

type IconName = keyof typeof ICONS;
type StatusFilter = 'all' | 'active' | 'completed' | 'problem';
type TypeFilter = 'all' | FolderKind;

const isTorrent = (d: Download) => d.kind === 'torrent';
const isActive = (d: Download) => d.status === 'downloading' || d.status === 'probing' || d.status === 'queued' || d.status === 'paused';
const hasProblem = (d: Download) => d.status === 'attention' || d.status === 'failed' || d.scan === 'threat';

const STATUS_FILTERS: Array<{ id: StatusFilter; label: (m: Messages) => string; test: (d: Download) => boolean }> = [
  { id: 'all', label: (m) => m.filterAll, test: () => true },
  { id: 'active', label: (m) => m.filterActive, test: isActive },
  { id: 'completed', label: (m) => m.filterCompleted, test: (d) => d.status === 'completed' },
  { id: 'problem', label: (m) => m.filterProblem, test: hasProblem },
];

const folderKindLabel = (kind: FolderKind) => (kind === 'torrent' ? m.torrentFilter : m.categories[kind]);
const kindOf = (d: Download): FolderKind => (isTorrent(d) ? 'torrent' : categoryFor(d));

let currentStatus: StatusFilter = 'all';
let currentType: TypeFilter = 'all';
let currentView: 'downloads' | 'settings' = 'downloads';
let searchQuery = '';
let latest: ApiState | null = null;
let desktop: DesktopInfo | null = null;
let language: Language = 'th';
let m: Messages = MESSAGES.th;

/** Before the server has named a file, the end of its address is the best name available. */
function displayName(d: Download): string {
  if (d.filename) return d.filename;
  try {
    const url = new URL(d.url);
    const last = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    return last || url.hostname || d.url;
  } catch {
    return d.url;
  }
}

/** A video's title usually has no file type until it finishes. */
function categoryFor(d: Download): Category {
  if (d.kind === 'video') return d.audioOnly ? 'audio' : 'video';
  return categoryOf(displayName(d));
}

/** True when this download is only waiting for the scheduled hours to begin. */
function waitingForSchedule(d: Download): boolean {
  const s = latest?.settings;
  return !!s?.scheduleEnabled && d.status === 'queued' && !d.runNow && !withinWindow(new Date(), s.scheduleStart, s.scheduleEnd);
}

function icon(name: IconName, size = 16): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(key, value);
  }
  for (const d of ICONS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

const DOTS = 20;

function fileType(d: Download): string {
  if (isTorrent(d)) return 'TOR';
  const type = /\.([a-z0-9]{1,4})$/i.exec(displayName(d))?.[1]?.toUpperCase();
  return d.kind === 'video' ? (d.status === 'completed' && type ? type : 'VID') : type ?? '';
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const value = seconds < 60 ? `${Math.ceil(seconds)} ${m.seconds}` : seconds < 3600 ? `${Math.ceil(seconds / 60)} ${m.minutes}` : `${(seconds / 3600).toFixed(1)} ${m.hours}`;
  return m.remaining ? `${m.remaining} ${value}` : value;
}

function formatStamp(ms: number): string {
  const when = new Date(ms);
  const time = new Intl.DateTimeFormat(m.locale, { hour: '2-digit', minute: '2-digit' });
  const full = new Intl.DateTimeFormat(m.locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return when.toDateString() === new Date().toDateString() ? `${m.today} ${time.format(when)}` : full.format(when);
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(error);
  return m.errors[raw.split(':')[0] as string] ?? raw;
}

function showError(error: unknown): void {
  $('error-text').textContent = errorText(error);
  $('error').hidden = false;
  // A switch or menu the user just changed goes back to what is really saved.
  if (latest) render(latest);
  renderDesktop();
}

const run = (task: () => Promise<unknown>) => {
  $('error').hidden = true;
  task().catch(showError);
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function textButton(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const b = element('button', className);
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

interface Row {
  root: HTMLElement;
  tile: HTMLElement;
  ext: HTMLElement;
  name: HTMLElement;
  sub: HTMLElement;
  status: HTMLElement;
  details: HTMLElement;
  when: HTMLElement;
  size: HTMLElement;
  dots: HTMLElement;
  dotsFill: HTMLElement;
  dotsShown: number;
  percent: HTMLElement;
  extra: HTMLElement;
  problem: HTMLElement;
  fixes: HTMLElement;
  replace: HTMLFormElement;
  replaceInput: HTMLInputElement;
  replaceSubmit: HTMLButtonElement;
  primary: HTMLButtonElement;
  more: HTMLButtonElement;
  primaryKey: string;
  fixesKey: string;
  signature: string;
  download: Download;
}

const rows = new Map<string, Row>();
const missingFiles = new Set<string>();
const STARTED_FLASH_MS = 2200;
const trackStarted = startTracker();

/** Set apart from the class name, which changes with every status. */
function flashRow(row: Row): void {
  row.root.dataset.started = '';
  setTimeout(() => { delete row.root.dataset.started; }, STARTED_FLASH_MS);
}

function createRow(download: Download): Row {
  const root = element('article', 'item');
  const tile = element('div', 'tile');
  const ext = element('span', 'ext');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(ext, icon('page', 18));
  const main = element('div', 'main');
  const name = element('div', 'name');
  const sub = element('div', 'sub');
  const status = element('span', 'status');
  const details = element('span', 'details');
  const when = element('span', 'when');
  sub.append(status, details, when);
  main.append(name, sub);
  const size = element('div', 'size');
  const meter = element('div', 'meter');
  const dots = element('div', 'dots');
  dots.setAttribute('role', 'progressbar');
  dots.setAttribute('aria-valuemin', '0');
  dots.setAttribute('aria-valuemax', '100');
  const dotsFill = element('div', 'dots-fill');
  dotsFill.style.width = '0';
  dots.append(dotsFill);
  const percent = element('span', 'percent');
  meter.append(dots, percent);
  const extra = element('div', 'extra');
  const problem = element('p', 'problem');
  const fixes = element('div', 'fixes');
  const replace = element('form', 'replace');
  replace.hidden = true;
  const replaceInput = element('input');
  replaceInput.type = 'url';
  replaceInput.required = true;
  const replaceSubmit = element('button');
  replaceSubmit.type = 'submit';
  replace.append(replaceInput, replaceSubmit);
  extra.append(problem, fixes, replace);

  const controls = element('div', 'controls');
  const primary = element('button', 'icon-button');
  primary.type = 'button';
  const more = element('button', 'icon-button');
  more.type = 'button';
  more.setAttribute('aria-haspopup', 'menu');
  more.append(icon('more'));
  controls.append(primary, more);

  root.append(tile, main, size, meter, controls, extra);
  const row: Row = { root, tile, ext, name, sub, status, details, when, size, dots, dotsFill, dotsShown: 0, percent, extra, problem, fixes, replace, replaceInput, replaceSubmit, primary, more, primaryKey: '', fixesKey: '', signature: '', download };
  replace.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = replaceInput.value;
    run(() => api.replaceUrl(row.download.id, url));
    replaceInput.value = '';
    replace.hidden = true;
  });
  primary.addEventListener('click', () => onPrimary(row));
  more.addEventListener('click', () => openMenu(row));
  return row;
}

/** Marks the row when its file is gone, and clears the mark if the file has come back. */
async function checkFile(id: string, task: Promise<FileCheck>): Promise<void> {
  if ((await task) === 'missing') missingFiles.add(id);
  else missingFiles.delete(id);
  if (latest) render(latest);
}

function onPrimary(row: Row): void {
  const d = row.download;
  if (d.status === 'paused') run(() => api.resume(d.id));
  else if (d.status === 'completed') run(() => checkFile(d.id, api.showInFolder(d.id)));
  else run(() => api.pause(d.id));
}

function renderPrimary(row: Row, d: Download): void {
  const kind = d.status === 'paused' ? 'play' : d.status === 'completed' ? 'folder' : d.status === 'attention' || d.status === 'failed' ? 'none' : 'pause';
  const key = `${kind}:${language}`;
  if (row.primaryKey === key) return;
  row.primaryKey = key;
  row.primary.hidden = kind === 'none';
  if (kind === 'none') return;
  const label = kind === 'play' ? m.resume : kind === 'folder' ? m.showInFolder : m.pause;
  row.primary.setAttribute('aria-label', label);
  row.primary.title = label;
  row.primary.replaceChildren(icon(kind as IconName));
}

function renderFixes(row: Row, d: Download, missing: boolean): void {
  const threat = d.status === 'completed' && d.scan === 'threat';
  const key = `${d.problem?.kind ?? ''}:${missing}:${threat}:${language}`;
  if (row.fixesKey === key) return;
  row.fixesKey = key;
  const list: HTMLElement[] = [];
  const add = (label: string, task: () => Promise<unknown>) => list.push(textButton(label, () => run(task)));
  const kind = d.problem?.kind;
  if (kind === 'link-expired') list.push(textButton(m.newLink, () => { row.replace.hidden = !row.replace.hidden; if (!row.replace.hidden) row.replaceInput.focus(); }));
  if (kind === 'link-expired' || kind === 'network' || kind === 'server' || kind === 'engine') add(m.retry, () => api.resume(d.id));
  if (kind === 'cannot-verify') add(m.resumeAnyway, () => api.resumeUnverified(d.id));
  if (d.problem) add(m.restart, () => api.restart(d.id));
  if (missing) {
    add(m.downloadAgain, () => api.restart(d.id));
    add(m.removeFromList, () => api.remove(d.id));
  } else if (threat) {
    add(m.moveToTrash, () => api.trashFile(d.id));
    add(m.removeFromList, () => api.remove(d.id));
  }
  row.fixes.replaceChildren(...list);
  row.fixes.hidden = list.length === 0;
  row.replaceInput.placeholder = m.newLinkLabel;
  row.replaceInput.setAttribute('aria-label', m.newLinkLabel);
  row.replaceSubmit.textContent = m.useLink;
  row.more.setAttribute('aria-label', m.more);
  row.more.title = m.more;
}

function sizeText(d: Download): string {
  if (d.status === 'completed') return formatBytes(d.totalBytes);
  if (d.totalBytes > 0) return `${formatBytes(d.completedBytes)} / ${formatBytes(d.totalBytes)}`;
  return d.completedBytes > 0 ? formatBytes(d.completedBytes) : '';
}

function detailsText(d: Download): string {
  if (d.status === 'completed') return d.scan === 'pending' ? m.scanPending : d.scan === 'clean' ? m.scanClean : '';
  if (d.status !== 'downloading') return '';
  // While a transfer is only starting, "0 B/s" says nothing useful.
  const parts = d.speed > 0 ? [`${formatBytes(d.speed)}${m.perSecond}`] : [];
  if (isTorrent(d) && d.connections > 0) parts.push(`${d.connections} ${m.peersUnit}`);
  const left = d.speed > 0 && d.totalBytes > 0 ? formatDuration((d.totalBytes - d.completedBytes) / d.speed) : '';
  if (left) parts.push(left);
  return parts.join(' · ');
}

/** Fills whole dots only, and touches the page only when another dot is due. */
function renderMeter(row: Row, d: Download): void {
  const known = d.status === 'completed' || d.totalBytes > 0;
  const fraction = d.status === 'completed' ? 1 : known ? Math.min(d.completedBytes / d.totalBytes, 1) : 0;
  const shown = fraction > 0 ? Math.max(1, Math.round(fraction * DOTS)) : 0;
  if (shown !== row.dotsShown) {
    row.dotsShown = shown;
    row.dotsFill.style.width = `calc(var(--dot-step) * ${shown})`;
  }
  const percent = Math.round(fraction * 100);
  row.dots.setAttribute('aria-valuenow', String(percent));
  row.percent.textContent = known ? `${percent}%` : '';
}

const TAIL_LENGTH = 12;

/** Long names are cut in the middle, so the end of the name and the file type stay visible. */
function renderName(host: HTMLElement, name: string): void {
  // Grapheme clusters keep Thai vowels, tone marks and emoji whole.
  const parts = Array.from(new Intl.Segmenter().segment(name), (s) => s.segment);
  const start = element('span', 'name-start');
  start.dir = 'auto';
  start.textContent = parts.length > TAIL_LENGTH * 2 ? parts.slice(0, -TAIL_LENGTH).join('') : name;
  const end = element('span', 'name-end');
  end.textContent = parts.length > TAIL_LENGTH * 2 ? parts.slice(-TAIL_LENGTH).join('') : '';
  host.replaceChildren(start, end);
}

function renderRow(row: Row, d: Download): void {
  // A long list repaints twice a second, and most rows have not changed.
  const waiting = waitingForSchedule(d);
  if (d.status !== 'completed') missingFiles.delete(d.id);
  const missing = missingFiles.has(d.id);
  const signature = `${language}|${waiting}|${missing}|${JSON.stringify(d)}`;
  if (row.signature === signature) return;
  row.signature = signature;
  row.download = d;
  const shownName = displayName(d);
  renderName(row.name, shownName);
  // Magnet links are long and carry trackers, so the tooltip shows the name instead.
  row.name.title = isTorrent(d) ? shownName : `${shownName}\n${d.url}`;
  const threat = d.status === 'completed' && d.scan === 'threat';
  row.status.textContent = missing ? m.fileMissingStatus : threat ? m.scanThreatStatus : waiting ? m.waitingSchedule(latest?.settings.scheduleStart ?? '') : m.status[d.status];
  row.status.className = `status ${missing || threat ? 'attention' : d.status}`;
  row.root.className = `item ${d.status}${threat ? ' threat' : ''}`;
  row.ext.textContent = fileType(d);
  row.size.textContent = sizeText(d);
  renderMeter(row, d);
  row.dots.setAttribute('aria-label', shownName);

  row.details.textContent = detailsText(d);
  const stamps = [`${m.started} ${formatStamp(d.createdAt)}`];
  if (d.completedAt) stamps.push(`${m.finished} ${formatStamp(d.completedAt)}`);
  row.when.textContent = stamps.join(' · ');
  // While a file downloads, the line shows speed and time left. The rest moves to a tooltip.
  const connections = !isTorrent(d) && d.connections > 0 ? `${d.connections} ${m.connectionUnit} · ` : '';
  row.sub.title = d.status === 'downloading' ? `${connections}${row.when.textContent}` : '';

  row.extra.hidden = !d.problem && !missing && !threat;
  row.problem.textContent = d.problem ? m.problems[d.problem.kind] : missing ? m.fileMissing : threat ? m.threatFound(d.threatName ?? null) : '';
  row.problem.title = d.problem?.message ?? '';
  renderPrimary(row, d);
  renderFixes(row, d, missing);
}

function openMenu(row: Row): void {
  const d = row.download;
  const menu = $('menu');
  const items: HTMLElement[] = [];
  const add = (name: IconName, label: string, task: () => Promise<unknown>, className?: string) => {
    const b = textButton('', () => {
      menu.hidePopover();
      run(task);
    }, className);
    const text = element('span');
    text.textContent = label;
    b.append(icon(name), text);
    b.setAttribute('role', 'menuitem');
    items.push(b);
  };
  if (d.status === 'completed') {
    // A file Defender flagged is not offered for opening from here.
    if (d.scan !== 'threat') add('open', m.openFile, () => checkFile(d.id, api.openFile(d.id)));
    add('folder', m.showInFolder, () => checkFile(d.id, api.showInFolder(d.id)));
    items.push(element('hr'));
    add('remove', m.removeFromList, () => api.remove(d.id));
    add('trash', m.moveToTrash, () => api.trashFile(d.id), 'danger');
  } else {
    if (waitingForSchedule(d)) add('play', m.startNow, () => api.startNow(d.id));
    add('restart', m.restart, () => api.restart(d.id));
    items.push(element('hr'));
    add('cancel', m.cancelAndDelete, () => api.remove(d.id), 'danger');
  }
  menu.replaceChildren(...items);
  menu.showPopover();
  const anchor = row.more.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, anchor.right - box.width)}px`;
  const below = anchor.bottom + 4;
  const fitsBelow = below + box.height <= window.innerHeight - 8;
  menu.style.top = `${fitsBelow ? below : Math.max(8, anchor.top - box.height - 4)}px`;
  menu.querySelector('button')?.focus();
}

const filterButtons = new Map<StatusFilter, HTMLButtonElement>();

function showView(view: 'downloads' | 'settings'): void {
  currentView = view;
  $('downloads-view').hidden = view !== 'downloads';
  $('settings-view').hidden = view !== 'settings';
  if (view === 'settings') $('settings-title').focus();
  if (latest) render(latest);
}

function buildFilters(): void {
  const host = $('filters');
  for (const def of STATUS_FILTERS) {
    const button = element('button', 'filter');
    button.type = 'button';
    button.addEventListener('click', () => {
      currentStatus = def.id;
      showView('downloads');
    });
    filterButtons.set(def.id, button);
    host.append(button);
  }
  $<HTMLSelectElement>('type-filter').addEventListener('change', (e) => {
    currentType = (e.target as HTMLSelectElement).value as TypeFilter;
    if (latest) render(latest);
  });
  const settings = $('open-settings');
  settings.append(icon('settings', 18));
  settings.addEventListener('click', () => showView(currentView === 'settings' ? 'downloads' : 'settings'));
  $('back').addEventListener('click', () => showView('downloads'));
}

function renderFilters(downloads: Download[]): void {
  for (const def of STATUS_FILTERS) {
    const button = filterButtons.get(def.id) as HTMLButtonElement;
    button.textContent = def.label(m);
    button.setAttribute('aria-pressed', String(def.id === currentStatus));
    if (def.id === 'problem') button.classList.toggle('alert', downloads.some(hasProblem));
  }
  const types = $<HTMLSelectElement>('type-filter');
  fillSelect(types, [['all', m.allTypes], ...FOLDER_KINDS.map((kind): [string, string] => [kind, folderKindLabel(kind)])], currentType);
  const settings = $('open-settings');
  if (currentView === 'settings') settings.setAttribute('aria-current', 'true');
  else settings.removeAttribute('aria-current');
}

const folderRows = new Map<FolderKind, { title: HTMLElement; path: HTMLElement; change: HTMLButtonElement; clear: HTMLButtonElement }>();

function buildCategoryFolders(): void {
  const host = $('category-folders');
  for (const kind of FOLDER_KINDS) {
    const row = element('div', 'card');
    const text = element('div', 'card-text');
    const title = element('div', 'card-title');
    const folder = element('div', 'card-note');
    text.append(title, folder);
    const actions = element('div', 'card-actions');
    const clear = textButton('', () => run(() => api.clearCategoryFolder(kind)));
    const change = textButton('', () => run(() => api.chooseFolder(kind)));
    actions.append(clear, change);
    row.append(text, actions);
    host.append(row);
    folderRows.set(kind, { title, path: folder, change, clear });
  }
}

function renderCategoryFolders(state: ApiState): void {
  for (const [kind, row] of folderRows) {
    const dir = state.settings.categoryDirs?.[kind];
    row.title.textContent = folderKindLabel(kind);
    row.path.textContent = dir ?? m.useMainFolder;
    row.change.textContent = m.change;
    row.clear.textContent = m.useMainFolderAction;
    row.clear.hidden = !dir;
  }
}

function renderSummary(downloads: Download[]): void {
  const active = downloads.filter((d) => d.status === 'downloading');
  const speed = active.reduce((sum, d) => sum + d.speed, 0);
  $('summary').textContent = active.length ? `${m.files(active.length)} · ${formatBytes(speed)}${m.perSecond}` : '';
}

/** Fills every label in the static page. Runs only when the language changes. */
function applyLanguage(next: Language): void {
  language = next;
  m = MESSAGES[next];
  document.documentElement.lang = next;
  const messages = m as unknown as Record<string, string>;
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = messages[el.dataset.i18n as string] ?? '';
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = messages[el.dataset.i18nPlaceholder as string] ?? '';
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-label]')) el.setAttribute('aria-label', messages[el.dataset.i18nLabel as string] ?? '');
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = messages[el.dataset.i18nTitle as string] ?? '';
    el.setAttribute('aria-label', el.title);
  }
  // Options are rebuilt so their labels follow the language too.
  $<HTMLSelectElement>('limit').replaceChildren();
  $<HTMLSelectElement>('type-filter').replaceChildren();
  renderDesktop();
}

function fillSelect(select: HTMLSelectElement, options: Array<[string, string]>, current: string): void {
  if (select.options.length === 0) {
    for (const [value, label] of options) select.add(new Option(label, value));
  }
  if (document.activeElement !== select) select.value = current;
}

function renderSettings(state: ApiState): void {
  $('folder-path').textContent = state.settings.defaultDir;
  renderCategoryFolders(state);
  const numbers = (values: number[]) => values.map((n): [string, string] => [String(n), String(n)]);
  fillSelect($('concurrent'), numbers([1, 2, 3, 4, 5, 8]), String(state.settings.maxConcurrent));
  fillSelect($('connections'), numbers([1, 2, 4, 8, 16]), String(state.settings.connections));
  fillSelect($('limit'), [['0', m.noLimit], ['500K', `500 KB${m.perSecond}`], ['1M', `1 MB${m.perSecond}`], ['5M', `5 MB${m.perSecond}`], ['10M', `10 MB${m.perSecond}`]], state.settings.speedLimit);
  $<HTMLSelectElement>('language').value = state.settings.language;
  $<HTMLInputElement>('capture').checked = state.settings.browserCapture;
  $<HTMLInputElement>('schedule-enabled').checked = state.settings.scheduleEnabled;
  $<HTMLInputElement>('shutdown-enabled').checked = state.settings.shutdownWhenDone;
  $('shutdown-note').hidden = !state.settings.shutdownWhenDone;
  for (const [id, time] of [['schedule-start', state.settings.scheduleStart], ['schedule-end', state.settings.scheduleEnd]] as const) {
    const input = $<HTMLInputElement>(id);
    if (document.activeElement !== input) input.value = time;
  }
  renderStats(state.stats);
  const extra = $<HTMLInputElement>('extra');
  if (document.activeElement !== extra) extra.value = state.settings.extraExtensions;
}

function renderDesktop(): void {
  if (!desktop) return;
  const auto = $<HTMLInputElement>('autostart');
  auto.checked = desktop.autoStart;
  auto.disabled = !desktop.packaged;
  $('autostart-note').textContent = desktop.packaged ? m.autoStartNote : m.autoStartUnavailable;
  $('version').textContent = `Speed Downloader ${desktop.version}`;
  renderExtensionLinks(desktop.extension);
}

/** Plain numbers about what the app did, so its reliability can be seen rather than claimed. */
function renderStats(stats: ReliabilityStats | undefined): void {
  const list = $('stats');
  if (!stats) return void list.replaceChildren();
  const date = new Intl.DateTimeFormat(m.locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(stats.since));
  $('stats-note').textContent = m.statsNote(date);
  const problems = Object.entries(stats.problems)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([kind, n]) => `${m.problemShort[kind as ProblemKind] ?? kind} ${n}`)
    .join(' · ');
  const pairs: Array<[string, string]> = [
    [m.statsCompleted, m.statsFilesValue(stats.completed, formatBytes(stats.completedBytes))],
    [m.statsResumed, m.statsResumedValue(stats.resumedAfterClose, formatBytes(stats.bytesKept))],
    [m.statsLinks, m.statsTimes(stats.linksReplaced)],
    [m.statsScanned, m.statsScannedValue(stats.scanned, stats.threats)],
    [m.statsProblems, problems || m.statsTimes(0)],
  ];
  list.replaceChildren(...pairs.map(([term, value]) => {
    const row = element('div', 'stat');
    const dt = element('dt');
    dt.textContent = term;
    const dd = element('dd');
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }));
}

/** One line per browser, so a missing or stale extension shows where the user already looks to install it. */
function renderExtensionLinks(status: ExtensionStatus): void {
  const list = $('extension-links');
  const lines: Array<{ text: string; state: 'ok' | 'problem' | 'none' }> = [];
  if (status.registered === false) lines.push({ text: m.extensionNotRegistered, state: 'problem' });
  for (const link of status.links) {
    lines.push(linkState(link, status.shippedVersion) === 'outdated'
      ? { text: m.extensionOutdated(link.browser), state: 'problem' }
      : { text: m.extensionSeen(link.browser, formatStamp(link.lastSeen)), state: 'ok' });
  }
  if (status.links.length === 0 && status.registered !== false) lines.push({ text: m.extensionNever, state: 'none' });
  list.replaceChildren(...lines.map(({ text, state }) => {
    const item = document.createElement('li');
    item.textContent = text;
    item.dataset.state = state;
    return item;
  }));
}

function emptyText(): [string, string] {
  if (searchQuery) return [m.noResultsTitle, m.noResultsBody];
  if (currentType !== 'all') return [m.emptyTypeTitle, m.emptyTypeBody(folderKindLabel(currentType))];
  switch (currentStatus) {
    case 'all': return [m.emptyAllTitle, m.emptyAllBody];
    case 'active': return [m.emptyActiveTitle, m.emptyActiveBody];
    case 'completed': return [m.emptyCompletedTitle, m.emptyCompletedBody];
    case 'problem': return [m.emptyProblemTitle, m.emptyProblemBody];
  }
}

const matchesSearch = (d: Download) => !searchQuery || displayName(d).toLocaleLowerCase().includes(searchQuery);

function render(state: ApiState): void {
  latest = state;
  if (state.settings.language !== language) {
    applyLanguage(state.settings.language);
  }
  const newestFirst = [...state.downloads].sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set(newestFirst.map((d) => d.id));
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.root.remove();
      rows.delete(id);
      missingFiles.delete(id);
    }
  }
  const statusTest = (STATUS_FILTERS.find((f) => f.id === currentStatus) ?? STATUS_FILTERS[0])!.test;
  const list = $('list');
  let previous: Element | null = null;
  let shown = 0;
  const justStarted = new Set(trackStarted(state.downloads));
  for (const d of newestFirst) {
    let row = rows.get(d.id);
    if (!row) {
      row = createRow(d);
      rows.set(d.id, row);
    }
    renderRow(row, d);
    if (justStarted.has(d.id)) flashRow(row);
    if (!statusTest(d) || (currentType !== 'all' && kindOf(d) !== currentType) || !matchesSearch(d)) {
      row.root.remove();
      continue;
    }
    shown++;
    const target: Element | null = previous ? previous.nextElementSibling : list.firstElementChild;
    if (target !== row.root) list.insertBefore(row.root, target);
    previous = row.root;
  }
  $('empty').hidden = shown > 0;
  $('table').hidden = shown === 0;
  if (!shown) {
    const [title, body] = emptyText();
    $('empty-title').textContent = title;
    $('empty-body').textContent = body;
  }
  renderFilters(state.downloads);
  renderSummary(state.downloads);
  renderSettings(state);
}

function bindSettings(): void {
  const value =(e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value;
  $('folder').addEventListener('click', () => run(() => api.chooseFolder()));
  $('extension-folder').addEventListener('click', () => run(() => api.openExtensionFolder()));
  $<HTMLInputElement>('capture').addEventListener('change', (e) => run(() => api.updateSettings({ browserCapture: (e.target as HTMLInputElement).checked })));
  $<HTMLInputElement>('extra').addEventListener('change', (e) => run(() => api.updateSettings({ extraExtensions: value(e) })));
  $<HTMLSelectElement>('concurrent').addEventListener('change', (e) => run(() => api.updateSettings({ maxConcurrent: Number(value(e)) })));
  $<HTMLSelectElement>('connections').addEventListener('change', (e) => run(() => api.updateSettings({ connections: Number(value(e)) })));
  $<HTMLSelectElement>('limit').addEventListener('change', (e) => run(() => api.updateSettings({ speedLimit: value(e) })));
  $<HTMLSelectElement>('language').addEventListener('change', (e) => run(() => api.updateSettings({ language: value(e) as Language })));
  $<HTMLInputElement>('shutdown-enabled').addEventListener('change', (e) => run(() => api.updateSettings({ shutdownWhenDone: (e.target as HTMLInputElement).checked })));
  $<HTMLInputElement>('schedule-enabled').addEventListener('change', (e) => run(() => api.updateSettings({ scheduleEnabled: (e.target as HTMLInputElement).checked })));
  $<HTMLInputElement>('schedule-start').addEventListener('change', (e) => { if (value(e)) run(() => api.updateSettings({ scheduleStart: value(e) })); });
  $<HTMLInputElement>('schedule-end').addEventListener('change', (e) => { if (value(e)) run(() => api.updateSettings({ scheduleEnd: value(e) })); });
  $<HTMLInputElement>('autostart').addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    run(async () => {
      await api.setAutoStart(enabled);
      if (desktop) desktop.autoStart = enabled;
    });
  });
}

$<HTMLFormElement>('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>('add-url');
  const url = input.value.trim();
  if (!url) return input.focus();
  run(async () => {
    await api.add(url);
    input.value = '';
  });
});
$('add-video').addEventListener('click', () => {
  const input = $<HTMLInputElement>('add-url');
  const url = input.value.trim();
  if (!url) return input.focus();
  run(async () => {
    await api.addVideo(url);
    input.value = '';
  });
});
$('open-torrent').addEventListener('click', () => run(() => api.openTorrentFile()));
$('error-close').append(icon('cancel', 14));
$('error-close').addEventListener('click', () => { $('error').hidden = true; });
$<HTMLInputElement>('search').addEventListener('input', (e) => {
  searchQuery = (e.target as HTMLInputElement).value.trim().toLocaleLowerCase();
  // Finding a file should work from wherever you are, as the Settings search box does.
  if (currentView !== 'downloads') showView('downloads');
  else if (latest) render(latest);
});

buildFilters();
buildCategoryFolders();
bindSettings();
applyLanguage(language);
api.onState(render);
api.onDesktop((info) => {
  desktop = info;
  renderDesktop();
});
api.onNavigate((target) => {
  if (target === 'settings') return showView('settings');
  currentStatus = target;
  currentType = 'all';
  $<HTMLSelectElement>('type-filter').value = 'all';
  showView('downloads');
});
Promise.all([api.getState(), api.getDesktop()]).then(([state, info]) => {
  desktop = info;
  render(state);
  renderDesktop();
}).catch(showError);
