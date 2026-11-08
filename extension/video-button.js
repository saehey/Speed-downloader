// Shows a download button beside a video playing on the page, and a menu of its qualities.
//
// It stays cheap on every page: nothing runs until a video starts or the pointer reaches one, and
// no address leaves the page until the user clicks. Videos using DRM get no button. The closed
// shadow root and the isTrusted checks stop the page from pressing the button by script.
(() => {
  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 135;
  const MARGIN = 10;
  const thai = chrome.i18n.getUILanguage().startsWith('th');
  const t = thai ? {
    button: 'โหลดวิดีโอ',
    reading: 'กำลังอ่านข้อมูลวิดีโอ…',
    choose: 'เลือกขนาดไฟล์',
    source: 'ไฟล์ต้นฉบับ',
    audio: 'เสียงอย่างเดียว',
    unknown: 'ไม่ทราบขนาด',
    sent: 'ส่งเข้า Speed Downloader แล้ว',
    hide: 'ซ่อนปุ่มในหน้านี้',
    reload: 'โหลดหน้านี้ใหม่แล้วลองอีกครั้ง',
    problems: {
      'video-drm': 'วิดีโอนี้มี DRM จึงโหลดไม่ได้',
      'video-unsupported': 'โหลดวิดีโอจากหน้านี้ไม่ได้ หรือเป็นการถ่ายทอดสด',
      'video-login': 'วิดีโอนี้ต้องล็อกอินก่อน ซึ่งยังไม่รองรับ',
      network: 'เชื่อมต่อเว็บไม่สำเร็จ ลองอีกครั้งได้',
      timeout: 'เว็บตอบช้าเกินไป ลองอีกครั้งได้',
      'no-app': 'เชื่อมต่อ Speed Downloader ไม่ได้ ลองเปิดโปรแกรมก่อน',
      other: 'อ่านข้อมูลวิดีโอไม่สำเร็จ',
    },
  } : {
    button: 'Get video',
    reading: 'Reading video details…',
    choose: 'Choose a size',
    source: 'Original file',
    audio: 'Audio only',
    unknown: 'Size unknown',
    sent: 'Sent to Speed Downloader',
    hide: 'Hide on this page',
    reload: 'Reload this page and try again',
    problems: {
      'video-drm': 'This video has DRM, so it cannot be downloaded.',
      'video-unsupported': 'No video can be downloaded from this page, or it is a live stream.',
      'video-login': 'This video needs a login, which is not supported yet.',
      network: 'Could not reach the site. You can try again.',
      timeout: 'The site took too long. You can try again.',
      'no-app': 'Could not reach Speed Downloader. Try opening the app first.',
      other: 'Could not read this video.',
    },
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 "Segoe UI Variable Text", "Segoe UI", "Leelawadee UI", system-ui, sans-serif; }
    button { margin: 0; border: 0; cursor: pointer; color: inherit; background: transparent; text-align: left; }
    button:focus-visible { outline: 2px solid #d6e86b; outline-offset: 1px; }
    .get { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px 0 9px; border-radius: 15px; background: #2a4234; color: #f2f0ea; font-weight: 600; white-space: nowrap; box-shadow: 0 2px 8px rgb(0 0 0 / 0.35); }
    .get:hover { background: #355340; }
    .get svg { flex: none; }
    .get circle { fill: #d6e86b; }
    .menu { position: absolute; top: calc(100% + 6px); right: 0; width: 270px; max-height: 340px; overflow-y: auto; padding: 0 5px 5px; border: 1px solid #d6d3c8; border-radius: 12px; background: #ffffff; color: #1f2e25; box-shadow: 0 8px 22px rgb(20 35 25 / 0.28); }
    .head { display: flex; align-items: center; height: 40px; padding: 0 8px; font-weight: 600; }
    .note { padding: 12px 8px 14px; color: #5c6a60; }
    .row { display: flex; align-items: center; gap: 8px; width: 100%; height: 36px; padding: 0 8px; border-radius: 8px; }
    .row:hover, .row:focus-visible { background: #e9ece3; outline: 0; }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .ext { color: #5c6a60; font-size: 11px; text-transform: uppercase; }
    .size { min-width: 74px; text-align: right; font-family: Consolas, "Leelawadee UI", monospace; font-size: 12px; }
    .hide { color: #5c6a60; margin-top: 4px; }
    @media (prefers-color-scheme: dark) {
      .menu { border-color: #3b4c41; background: #223027; color: #e8ede6; }
      .note, .ext, .hide { color: #a3b0a6; }
      .row:hover, .row:focus-visible { background: #2f3e35; }
    }
  `;
  const MARK = [[3, 0], [3, 1], [1, 2], [3, 2], [5, 2], [2, 3], [3, 3], [4, 3], [3, 4], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6]];

  let current = null;
  let host = null;
  let getButton = null;
  let menu = null;
  let dismissed = false;
  let open = false;
  let timer = null;
  let framePending = false;
  let checkPending = false;
  let mediaSeen = false;

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function markIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    for (const [x, y] of MARK) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(x * 2 + 1));
      dot.setAttribute('cy', String(y * 2 + 1));
      dot.setAttribute('r', '0.9');
      svg.append(dot);
    }
    return svg;
  }

  function build() {
    host = document.createElement('div');
    host.setAttribute('data-speed-downloader', '');
    const style = host.style;
    style.setProperty('all', 'initial', 'important');
    style.setProperty('position', 'fixed', 'important');
    style.setProperty('z-index', '2147483647', 'important');
    const root = host.attachShadow({ mode: 'closed' });
    // A constructed stylesheet works even on pages whose security policy blocks inline styles.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    getButton = make('button', 'get');
    getButton.type = 'button';
    getButton.append(markIcon(), make('span', '', t.button));
    getButton.addEventListener('click', (event) => {
      if (event.isTrusted) toggleMenu();
    });
    menu = make('div', 'menu');
    menu.hidden = true;
    menu.style.display = 'none';
    menu.setAttribute('role', 'menu');
    root.append(getButton, menu);
    (document.fullscreenElement ?? document.documentElement).append(host);
  }

  const playable = (video) => {
    if (!video.isConnected || video.mediaKeys) return false;
    const rect = video.getBoundingClientRect();
    if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return false;
    if (rect.bottom < 40 || rect.top > innerHeight - 40 || rect.right < 40 || rect.left > innerWidth - 40) return false;
    return !!(video.currentSrc || video.src || video.querySelector('source'));
  };

  function largestVideo() {
    let best = null;
    let bestArea = 0;
    for (const video of document.getElementsByTagName('video')) {
      if (!playable(video)) continue;
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    }
    return best;
  }

  function place() {
    framePending = false;
    if ((!current && !mediaSeen) || !host) return;
    const width = getButton.offsetWidth;
    if (!current) {
      // The player keeps its video out of reach, so the button waits in the corner of the page.
      host.style.setProperty('top', `${MARGIN}px`, 'important');
      host.style.setProperty('left', `${innerWidth - width - MARGIN}px`, 'important');
      return;
    }
    const rect = current.getBoundingClientRect();
    const top = Math.max(MARGIN, Math.min(rect.top + MARGIN, innerHeight - 40));
    const left = Math.max(MARGIN, Math.min(rect.right - width - MARGIN, innerWidth - width - MARGIN));
    host.style.setProperty('top', `${top}px`, 'important');
    host.style.setProperty('left', `${left}px`, 'important');
  }

  function placeSoon() {
    if (framePending || !current) return;
    framePending = true;
    requestAnimationFrame(place);
  }

  function setRunning(running) {
    if (running && timer === null) {
      timer = setInterval(check, 1000);
      addEventListener('scroll', placeSoon, { capture: true, passive: true });
      addEventListener('resize', placeSoon, { passive: true });
    } else if (!running && timer !== null) {
      clearInterval(timer);
      timer = null;
      removeEventListener('scroll', placeSoon, { capture: true });
      removeEventListener('resize', placeSoon);
    }
  }

  function check() {
    checkPending = false;
    const next = dismissed ? null : largestVideo();
    // A video using DRM never gets the button, even when its requests were seen.
    const protectedVideo = [...document.getElementsByTagName('video')].some((video) => video.mediaKeys);
    const show = !dismissed && !protectedVideo && (!!next || mediaSeen);
    if (!show && open) closeMenu();
    if (show && !host) build();
    current = next;
    if (show && !host.isConnected) (document.fullscreenElement ?? document.documentElement).append(host);
    if (!show && host) host.remove();
    setRunning(show);
    if (show) place();
  }

  function checkSoon() {
    if (checkPending) return;
    checkPending = true;
    setTimeout(check, 100);
  }

  function formatSize(choice) {
    if (!choice.bytes) return t.unknown;
    const mb = choice.bytes / (1024 * 1024);
    const text = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
    return choice.approximate ? `~${text}` : text;
  }

  function labelOf(choice) {
    if (choice.audioOnly) return t.audio;
    if (!choice.height) return t.source;
    return `${choice.height}p${choice.fps && choice.fps > 30 ? Math.round(choice.fps) : ''}`;
  }

  function clock(seconds) {
    const whole = Math.round(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = String(whole % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  }

  async function ask(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      // The extension was reloaded while this page stayed open.
      return { ok: false, problem: 'reload' };
    }
  }

  const problemText = (problem) => (problem === 'reload' ? t.reload : t.problems[problem] ?? t.problems.other);

  function showNote(text) {
    menu.replaceChildren(make('div', 'note', text));
  }

  function hideButton() {
    return Object.assign(make('button', 'row hide', t.hide), {
      type: 'button',
      onclick: (event) => {
        if (!event.isTrusted) return;
        dismissed = true;
        closeMenu();
        check();
      },
    });
  }

  function directSource() {
    const src = current?.currentSrc || current?.src || current?.querySelector('source')?.src || '';
    return /^https?:/i.test(src) ? src : '';
  }

  async function toggleMenu() {
    if (open) return closeMenu();
    open = true;
    menu.hidden = false;
    menu.style.display = 'block';
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);
    showNote(t.reading);
    const page = location.href;
    const referrer = document.referrer;
    const duration = Number.isFinite(current?.duration) ? current.duration : null;
    const info = await ask({ type: 'video-info', url: page, referrer, src: directSource(), title: document.title, duration });
    if (!open) return;
    if (!info?.ok) {
      menu.replaceChildren(make('div', 'note', problemText(info?.problem)), hideButton());
      return;
    }
    const rows = info.choices.map((choice) => {
      const row = make('button', 'row');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      // Several sources on one page, such as an advert and the film, are told apart by their length.
      const length = info.sources > 1 && choice.duration ? ` · ${clock(choice.duration)}` : '';
      row.append(make('span', 'label', `${labelOf(choice)}${length}`), make('span', 'ext', choice.ext), make('span', 'size', formatSize(choice)));
      row.addEventListener('click', async (event) => {
        if (!event.isTrusted) return;
        showNote(t.reading);
        const added = await ask({ type: 'video-add', url: choice.url ?? info.url, referrer, format: choice.format, title: info.title, audioOnly: choice.audioOnly });
        showNote(added?.ok ? t.sent : problemText(added?.problem));
        if (added?.ok) setTimeout(closeMenu, 1800);
      });
      return row;
    });
    menu.replaceChildren(make('div', 'head', t.choose), ...rows, hideButton());
    rows[0]?.focus();
  }

  function closeMenu() {
    open = false;
    if (menu) {
      menu.hidden = true;
      menu.style.display = 'none';
    }
    document.removeEventListener('pointerdown', closeOutside, true);
    document.removeEventListener('keydown', closeOnEscape, true);
  }

  function closeOutside(event) {
    if (!event.composedPath().includes(host)) closeMenu();
  }

  function closeOnEscape(event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeMenu();
    getButton.focus();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'media-seen') return;
    mediaSeen = true;
    checkSoon();
  });

  // Media events do not bubble, but a listener on the document still sees them while capturing.
  for (const name of ['loadedmetadata', 'play', 'playing', 'encrypted']) document.addEventListener(name, checkSoon, true);
  document.addEventListener('pointerover', (event) => {
    if (event.target instanceof HTMLVideoElement && event.target !== current) checkSoon();
  }, { capture: true, passive: true });
  document.addEventListener('fullscreenchange', () => {
    if (host) host.remove();
    check();
  });
  if (document.getElementsByTagName('video').length) checkSoon();
})();
