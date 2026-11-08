// Offers each new download to the Speed Downloader app. Whenever the app does not answer in time or the
// connection fails, the browser simply carries on with the download itself.
const HOST = 'com.downloader.host';
const DECISION_TIMEOUT_MS = 15000;
const NAME_WAIT_MS = 250;
const IDLE_DISCONNECT_MS = 30000;
const SKIP_MS = 60000;
const SKIP_ALARM = 'skip-expired';

const VIDEO_TIMEOUT_MS = 60000;

const pending = new Map();
const videoRequests = new Map();
let nextVideoRequest = 1;
let skipUntil = 0;

// The toolbar button lets the next download stay in the browser. Chrome can stop this service
// worker at any time, so the choice is kept in session storage, which ends with the browser.
const skipLoaded = chrome.storage.session.get('skipUntil').then((saved) => {
  skipUntil = saved.skipUntil || 0;
  showSkip();
}).catch(() => {});

function showSkip() {
  const thai = chrome.i18n.getUILanguage().startsWith('th');
  const on = Date.now() < skipUntil;
  chrome.action.setBadgeText({ text: on ? (thai ? 'ข้าม' : 'SKIP') : '' });
  chrome.action.setTitle({
    title: on
      ? (thai ? 'ไฟล์ถัดไปจะโหลดในเบราว์เซอร์ กดอีกครั้งเพื่อยกเลิก' : 'The next file stays in the browser. Click again to cancel.')
      : (thai ? 'กดเพื่อให้ไฟล์ถัดไปโหลดในเบราว์เซอร์' : 'Click to keep the next file in the browser'),
  });
}

function setSkip(until) {
  skipUntil = until;
  void chrome.storage.session.set({ skipUntil: until });
  if (until) chrome.alarms.create(SKIP_ALARM, { when: until });
  else void chrome.alarms.clear(SKIP_ALARM);
  showSkip();
}

chrome.action.onClicked.addListener(async () => {
  await skipLoaded;
  setSkip(Date.now() < skipUntil ? 0 : Date.now() + SKIP_MS);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SKIP_ALARM) setSkip(0);
});
let port = null;
let idleTimer = null;

function getPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((message) => {
    if (message.type === 'decision') decide(message.id, message.decision, message.reason);
    else if (message.type === 'video-result') finishVideo(message.id, message);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    for (const id of [...pending.keys()]) decide(id, 'reject', 'host-disconnected');
    for (const id of [...videoRequests.keys()]) finishVideo(id, { ok: false, problem: 'no-app' });
  });
  return port;
}

// Questions from the button beside a video. They exist only after the user has clicked it.
function finishVideo(id, result) {
  const request = videoRequests.get(id);
  if (!request) return;
  videoRequests.delete(id);
  clearTimeout(request.timer);
  const { type, id: _id, ...answer } = result;
  request.respond(answer);
  scheduleDisconnect();
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || (message.type !== 'video-info' && message.type !== 'video-add')) return false;
  void sendVideoRequest(message, sender, respond);
  return true;
});

async function sendVideoRequest(message, sender, respond) {
  const id = nextVideoRequest++;
  const timer = setTimeout(() => finishVideo(id, { ok: false, problem: 'timeout' }), VIDEO_TIMEOUT_MS);
  videoRequests.set(id, { respond, timer });
  try {
    await mediaLoaded;
    const seen = mediaByTab[sender.tab.id] ?? [];
    const base = { type: message.type, id, url: message.url, referrer: message.referrer || null, src: message.src || null, format: message.format || null, userAgent: navigator.userAgent, title: message.type === 'video-add' ? message.title || null : sender.tab.title || message.title || null, duration: message.duration || null, audioOnly: message.audioOnly === true };
    if (message.type === 'video-info') {
      // Newest first, and cookies are read only now, after the user has clicked.
      const newest = [...seen].reverse().slice(0, MAX_MEDIA_ASKED);
      base.media = await Promise.all(newest.map(async (m) => ({ url: m.url, kind: m.kind, referrer: m.referrer, origin: m.origin, bytes: m.bytes, cookie: await cookieJar(m.url) })));
    } else {
      const chosen = seen.find((m) => m.url === message.url);
      if (chosen) Object.assign(base, { referrer: chosen.referrer, origin: chosen.origin, cookie: await cookieJar(chosen.url) });
    }
    getPort().postMessage(base);
  } catch {
    finishVideo(id, { ok: false, problem: 'no-app' });
  }
}

/** The browser's cookies for one address, in the file format yt-dlp reads. They stay scoped to their sites. */
async function cookieJar(url) {
  const cookies = await chrome.cookies.getAll({ url }).catch(() => []);
  if (cookies.length === 0) return null;
  const lines = cookies.map((c) => [c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path, c.secure ? 'TRUE' : 'FALSE', Math.floor(c.expirationDate ?? 0), c.name, c.value].join('\t'));
  return `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`;
}

// Watches what the page's player really requests, so a video can be found without knowing the site.
// Addresses stay in this browser's memory for the tab and go nowhere until the user clicks.
const MEDIA_LIMIT = 8;
const MAX_MEDIA_ASKED = 4;
const MIN_FILE_BYTES = 1024 * 1024;
const PLAYLIST_BURST_MS = 5000;
let mediaByTab = {};
const requestHeaders = new Map();
const mediaLoaded = chrome.storage.session.get('mediaByTab').then((saved) => {
  mediaByTab = saved.mediaByTab || {};
}).catch(() => {});

/** Returns 'hls', 'dash' or 'file' for something playable, and null for pieces and everything else. */
function classifyMedia(url, contentType, bytes) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const file = parsed.pathname.toLowerCase();
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (file.endsWith('.m3u8') || type.includes('mpegurl')) return 'hls';
  if (file.endsWith('.mpd') || type === 'application/dash+xml') return 'dash';
  if (/\.(ts|m4s|m4a|m4f|aac|mp3|vtt|jpg|png|webp)$/.test(file) || type === 'video/mp2t') return null;
  // Sites that stream by byte range fetch pieces that look like files.
  if (parsed.searchParams.has('range') || parsed.searchParams.has('sq')) return null;
  if (!/\.(mp4|m4v|webm|mkv|mov|flv|avi)$/.test(file) && !type.startsWith('video/')) return null;
  return bytes === null || bytes >= MIN_FILE_BYTES ? 'file' : null;
}

function rememberMedia(details) {
  if (details.tabId < 0 || (details.statusCode !== 200 && details.statusCode !== 206)) return;
  const header = (name) => details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
  const length = Number(header('content-length'));
  const total = /\/(\d+)$/.exec(header('content-range') || '')?.[1];
  const bytes = total ? Number(total) : Number.isFinite(length) && length > 0 ? length : null;
  const kind = classifyMedia(details.url, header('content-type'), bytes);
  const sent = requestHeaders.get(details.requestId);
  requestHeaders.delete(details.requestId);
  if (!kind) return;
  void mediaLoaded.then(() => {
    const list = mediaByTab[details.tabId] ?? [];
    const sameFrame = list.filter((m) => m.frameId === details.frameId);
    const manifest = kind !== 'file';
    const now = Date.now();
    if (list.some((m) => m.url === details.url)) return;
    // A playlist's own quality lists arrive straight after it, and a manifest's files are its pieces.
    if (!manifest && sameFrame.some((m) => m.kind !== 'file')) return;
    if (manifest && sameFrame.some((m) => m.kind === kind && now - m.at < PLAYLIST_BURST_MS)) return;
    const kept = manifest ? list.filter((m) => m.frameId !== details.frameId || m.kind !== 'file') : list;
    const initiator = details.initiator && details.initiator !== 'null' ? details.initiator : null;
    kept.push({ url: details.url, kind, bytes, frameId: details.frameId, at: now, referrer: sent?.referrer ?? (initiator ? `${initiator}/` : null), origin: sent?.origin ?? null });
    mediaByTab[details.tabId] = kept.slice(-MEDIA_LIMIT);
    void chrome.storage.session.set({ mediaByTab });
    chrome.tabs.sendMessage(details.tabId, { type: 'media-seen' }, { frameId: details.frameId }, () => void chrome.runtime.lastError);
  });
}

function forgetTab(tabId) {
  void mediaLoaded.then(() => {
    if (!mediaByTab[tabId]) return;
    delete mediaByTab[tabId];
    void chrome.storage.session.set({ mediaByTab });
  });
}

const MEDIA_FILTER = { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] };
chrome.webRequest.onSendHeaders.addListener((details) => {
  if (!classifyMedia(details.url, null, null) && !/\.(m3u8|mpd)(\?|$)/i.test(details.url)) return;
  const header = (name) => details.requestHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
  requestHeaders.set(details.requestId, { referrer: header('referer') ?? null, origin: header('origin') ?? null });
  if (requestHeaders.size > 64) requestHeaders.delete(requestHeaders.keys().next().value);
}, MEDIA_FILTER, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onResponseStarted.addListener(rememberMedia, MEDIA_FILTER, ['responseHeaders', 'extraHeaders']);
// A new page in the tab starts a fresh list.
chrome.webRequest.onBeforeRequest.addListener((details) => forgetTab(details.tabId), { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] });
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

// Without this, an open port would keep the service worker and the host running forever.
function scheduleDisconnect() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0 && videoRequests.size === 0 && port) {
      port.disconnect();
      port = null;
    }
  }, IDLE_DISCONNECT_MS);
}

function decide(id, decision, reason) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  clearTimeout(entry.nameTimer);
  console.debug('Speed Downloader', id, decision, reason);
  if (decision === 'accept') {
    chrome.downloads.cancel(id, () => {
      void chrome.runtime.lastError;
      chrome.downloads.erase({ id }, () => void chrome.runtime.lastError);
    });
  } else {
    chrome.downloads.resume(id, () => void chrome.runtime.lastError);
    notifyStaysInBrowser(entry);
  }
  entry.suggest?.();
  scheduleDisconnect();
}

async function offer(id) {
  const entry = pending.get(id);
  if (!entry || entry.sent) return;
  entry.sent = true;
  const { item } = entry;
  const target = item.finalUrl || item.url;
  const cookies = await chrome.cookies.getAll({ url: target }).catch(() => []);
  if (!pending.has(id)) return;
  try {
    getPort().postMessage({
      type: 'download',
      id,
      url: item.url,
      finalUrl: item.finalUrl || null,
      filename: entry.filename || null,
      referrer: item.referrer || null,
      mime: item.mime || null,
      totalBytes: item.totalBytes,
      userAgent: navigator.userAgent,
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    });
  } catch {
    decide(id, 'reject', 'post-failed');
  }
}

// Pausing a download or holding its file name stops Chrome from showing its download bubble
// (tested on Chrome 156). So files that will clearly stay in the browser are left untouched.
const MIN_BYTES = 256 * 1024;
const BROWSER_EXTENSIONS = /\.(asp|aspx|avif|css|gif|htm|html|ico|ics|jpeg|jpg|js|json|jsp|log|md|mjs|php|png|svg|torrent|txt|vcf|webp|xml)$/i;
const BROWSER_MIME = /^(text\/|image\/)/i;

function clearlyStaysInBrowser(item, url) {
  if (item.totalBytes > 0 && item.totalBytes < MIN_BYTES) return true;
  if (BROWSER_MIME.test(item.mime || '')) return true;
  try {
    return BROWSER_EXTENSIONS.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

function notifyStaysInBrowser(entry) {
  const url = entry.item.finalUrl || entry.item.url || '';
  let name = entry.filename;
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch {
      name = '';
    }
  }
  const thai = chrome.i18n.getUILanguage().startsWith('th');
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: thai ? 'เบราว์เซอร์กำลังโหลดไฟล์นี้' : 'The browser is downloading this file',
    message: `${name || (thai ? 'ไฟล์ของคุณ' : 'Your file')}\n${thai ? 'กด Ctrl+J เพื่อดูการดาวน์โหลด' : 'Press Ctrl+J to see your downloads'}`,
  }, () => void chrome.runtime.lastError);
}

function shouldOffer(item) {
  const url = item.finalUrl || item.url || '';
  if (!/^https?:/i.test(url)) return false;
  if (clearlyStaysInBrowser(item, url)) return false;
  // Private window cookies must not reach an app that keeps a queue on disk.
  if (item.incognito) return false;
  if (item.state !== 'in_progress') return false;
  return true;
}

chrome.downloads.onCreated.addListener(async (item) => {
  await skipLoaded;
  if (!shouldOffer(item)) return;
  // Files the browser keeps anyway do not use up the skip.
  if (Date.now() < skipUntil) return setSkip(0);
  const entry = { item, sent: false, filename: null, suggest: null };
  entry.timer = setTimeout(() => decide(item.id, 'reject', 'timeout'), DECISION_TIMEOUT_MS);
  entry.nameTimer = setTimeout(() => void offer(item.id), NAME_WAIT_MS);
  pending.set(item.id, entry);
  chrome.downloads.pause(item.id, () => void chrome.runtime.lastError);
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const entry = pending.get(item.id);
  if (!entry) return;
  entry.suggest = suggest;
  entry.filename = (item.filename || '').split(/[\\/]/).pop() || null;
  clearTimeout(entry.nameTimer);
  void offer(item.id);
  return true;
});
