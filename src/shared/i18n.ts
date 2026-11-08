import type { DownloadStatus, Language, ProblemKind } from './types.ts';
import type { Category } from './categories.ts';

export interface Messages {
  locale: string;
  searchPlaceholder: string;
  noResultsTitle: string;
  noResultsBody: string;
  columnFile: string;
  columnSize: string;
  columnProgress: string;
  addPlaceholder: string;
  addLabel: string;
  addButton: string;
  addVideo: string;
  addVideoNote: string;
  sectionSchedule: string;
  scheduleEnabled: string;
  scheduleNote: string;
  scheduleStart: string;
  scheduleEnd: string;
  waitingSchedule: (time: string) => string;
  startNow: string;
  skipOnce: string;
  skipOnceNote: string;
  openTorrent: string;
  filtersLabel: string;
  settings: string;
  done: string;
  sectionDownloads: string;
  sectionBrowser: string;
  sectionGeneral: string;
  saveTo: string;
  saveToNote: string;
  shutdownWhenDone: string;
  shutdownNote: string;
  shutdownArmed: string;
  shutdownTitle: string;
  shutdownDetail: (failed: number) => string;
  shutdownCancel: string;
  shutdownNow: string;
  shutdownFailed: string;
  sectionFolders: string;
  foldersNote: string;
  useMainFolder: string;
  useMainFolderAction: string;
  allTypes: string;
  typeFilterLabel: string;
  backToDownloads: string;
  change: string;
  concurrent: string;
  connections: string;
  speedLimit: string;
  noLimit: string;
  perSecond: string;
  capture: string;
  extraTypes: string;
  extraPlaceholder: string;
  extraNote: string;
  installExtension: string;
  installExtensionNote: string;
  openFolder: string;
  autoStart: string;
  autoStartNote: string;
  autoStartUnavailable: string;
  language: string;
  filterAll: string;
  filterActive: string;
  filterCompleted: string;
  filterProblem: string;
  categories: Record<Category, string>;
  status: Record<DownloadStatus, string>;
  problems: Record<ProblemKind, string>;
  pause: string;
  resume: string;
  more: string;
  newLink: string;
  useLink: string;
  newLinkLabel: string;
  retry: string;
  resumeAnyway: string;
  restart: string;
  openFile: string;
  showInFolder: string;
  removeFromList: string;
  moveToTrash: string;
  cancelAndDelete: string;
  connectionUnit: string;
  peersUnit: string;
  remaining: string;
  started: string;
  finished: string;
  today: string;
  seconds: string;
  minutes: string;
  hours: string;
  files: (count: number) => string;
  emptyAllTitle: string;
  emptyAllBody: string;
  emptyActiveTitle: string;
  emptyActiveBody: string;
  emptyCompletedTitle: string;
  emptyCompletedBody: string;
  emptyProblemTitle: string;
  emptyProblemBody: string;
  emptyTypeTitle: string;
  emptyTypeBody: (category: string) => string;
  trayOpen: string;
  trayPauseAll: string;
  trayResumeAll: string;
  trayQuit: string;
  trayActive: (count: number, speed: string) => string;
  trayIdle: string;
  trayProblems: (count: number) => string;
  trayAddLink: (host: string) => string;
  trayAddLinkNone: string;
  trayRecent: string;
  trayOpenFolder: string;
  trayCaptured: string;
  trayHint: string;
  riskyTitle: (name: string) => string;
  riskyDetail: string;
  riskyOpen: string;
  riskyCancel: string;
  torrentFilter: string;
  startFailed: string;
  errorInstalledOnly: string;
  fileMissingStatus: string;
  fileMissing: string;
  downloadAgain: string;
  errorOpenFile: string;
  errorOpenFolder: string;
  errorTrash: string;
  pickerOpen: string;
  closeNotice: string;
  /** The core reports errors in English. Each is looked up by its text before the first colon. */
  errors: Record<string, string>;
}

export const MESSAGES: Record<Language, Messages> = {
  th: {
    locale: 'th-TH',
    searchPlaceholder: 'ค้นหาไฟล์',
    noResultsTitle: 'ไม่พบไฟล์นี้',
    noResultsBody: 'ลองค้นหาด้วยคำอื่น',
    columnFile: 'ไฟล์',
    columnSize: 'ขนาด',
    columnProgress: 'ความคืบหน้า',
    addPlaceholder: 'วางลิงก์หรือ magnet ที่ต้องการดาวน์โหลด',
    addLabel: 'ลิงก์ที่ต้องการดาวน์โหลด',
    addButton: 'ดาวน์โหลด',
    addVideo: 'โหลดวิดีโอ',
    addVideoNote: 'วางลิงก์หน้าวิดีโอแล้วกดปุ่มนี้ ใช้ได้เฉพาะวิดีโอที่ไม่มี DRM',
    sectionSchedule: 'ตั้งเวลา',
    scheduleEnabled: 'โหลดเฉพาะช่วงเวลาที่กำหนด',
    scheduleNote: 'นอกช่วงเวลานี้งานจะรอคิว เครื่องต้องเปิดอยู่และโปรแกรมต้องทำงาน',
    scheduleStart: 'เริ่มเวลา',
    scheduleEnd: 'หยุดเวลา',
    waitingSchedule: (time) => `รอถึง ${time}`,
    startNow: 'เริ่มเดี๋ยวนี้',
    skipOnce: 'ให้เบราว์เซอร์โหลดเองเฉพาะครั้ง',
    skipOnceNote: 'กดไอคอน Speed Downloader บนแถบเครื่องมือเบราว์เซอร์ ไฟล์ถัดไปภายใน 1 นาทีจะไม่ถูกส่งมาที่โปรแกรม',
    openTorrent: 'เปิดไฟล์ .torrent',
    filtersLabel: 'ตัวกรองรายการ',
    settings: 'การตั้งค่า',
    done: 'เสร็จ',
    sectionDownloads: 'การดาวน์โหลด',
    sectionBrowser: 'เบราว์เซอร์',
    sectionGeneral: 'ทั่วไป',
    saveTo: 'บันทึกไฟล์ที่',
    saveToNote: 'มีผลกับไฟล์ที่เพิ่มใหม่ ไฟล์ที่เริ่มโหลดแล้วจะบันทึกที่เดิม',
    shutdownWhenDone: 'ปิดเครื่องเมื่อโหลดเสร็จ',
    shutdownNote: 'มีเวลายกเลิก 60 วินาทีก่อนปิด ใช้ครั้งเดียวและจะปิดตัวเลือกนี้เอง งานที่หยุดชั่วคราวจะไม่ถูกรอ',
    shutdownArmed: 'จะปิดเครื่องเมื่อโหลดเสร็จ',
    shutdownTitle: 'โหลดเสร็จแล้ว เครื่องจะปิดใน 60 วินาที',
    shutdownDetail: (failed) => (failed ? `มี ${failed} รายการที่โหลดไม่สำเร็จหรือรอการตัดสินใจ ` : '') + 'ถ้ามีโปรแกรมที่ยังไม่ได้บันทึกงาน Windows อาจรอให้จัดการก่อนปิด',
    shutdownCancel: 'ไม่ปิดเครื่อง',
    shutdownNow: 'ปิดเครื่องเดี๋ยวนี้',
    shutdownFailed: 'ปิดเครื่องไม่สำเร็จ',
    sectionFolders: 'โฟลเดอร์แยกตามประเภทไฟล์',
    foldersNote: 'ประเภทที่ไม่ได้ตั้งจะบันทึกในโฟลเดอร์หลัก มีผลกับไฟล์ที่เพิ่มใหม่',
    useMainFolder: 'ใช้โฟลเดอร์หลัก',
    useMainFolderAction: 'ใช้โฟลเดอร์หลัก',
    allTypes: 'ทุกประเภท',
    typeFilterLabel: 'กรองตามประเภทไฟล์',
    backToDownloads: 'กลับไปรายการดาวน์โหลด',
    change: 'เปลี่ยน',
    concurrent: 'โหลดพร้อมกัน',
    connections: 'จำนวน connection ต่อไฟล์',
    speedLimit: 'จำกัดความเร็ว',
    noLimit: 'ไม่จำกัด',
    perSecond: '/วินาที',
    capture: 'รับไฟล์จากเบราว์เซอร์',
    extraTypes: 'ชนิดไฟล์ที่รับเพิ่ม',
    extraPlaceholder: 'เช่น dat, nds',
    extraNote: 'รับ วิดีโอ เพลง เอกสาร โปรแกรม และไฟล์บีบอัดอยู่แล้ว คั่นชนิดไฟล์ด้วยจุลภาค',
    installExtension: 'ติดตั้ง extension',
    installExtensionNote: 'เปิด chrome://extensions หรือ edge://extensions เปิด Developer mode กด Load unpacked แล้วเลือกโฟลเดอร์นี้',
    openFolder: 'เปิดโฟลเดอร์',
    autoStart: 'เปิดพร้อม Windows',
    autoStartNote: 'ทำงานเงียบ ๆ ใน system tray',
    autoStartUnavailable: 'ตั้งค่าได้เมื่อติดตั้งโปรแกรมแล้ว',
    language: 'ภาษา',
    filterAll: 'ทั้งหมด',
    filterActive: 'กำลังดำเนินการ',
    filterCompleted: 'เสร็จแล้ว',
    filterProblem: 'ต้องดูแล',
    categories: { video: 'วิดีโอ', audio: 'เพลง', document: 'เอกสาร', program: 'โปรแกรม', archive: 'ไฟล์บีบอัด', other: 'อื่น ๆ' },
    status: { queued: 'รอคิว', probing: 'กำลังตรวจไฟล์', downloading: 'กำลังดาวน์โหลด', paused: 'หยุดชั่วคราว', completed: 'เสร็จแล้ว', attention: 'รอการตัดสินใจ', failed: 'ไม่สำเร็จ' },
    problems: {
      'link-expired': 'Server ปฏิเสธลิงก์นี้ อาจหมดอายุหรือต้องล็อกอินใหม่ ใส่ลิงก์ใหม่เพื่อโหลดต่อจากเดิมได้',
      'remote-changed': 'ไฟล์บน server เปลี่ยนไปแล้ว ถ้าโหลดต่อไฟล์จะเสีย จึงต้องเริ่มใหม่',
      'cannot-verify': 'Server ไม่ให้ข้อมูลสำหรับตรวจว่าไฟล์ยังเหมือนเดิม ถ้าโหลดต่ออาจได้ไฟล์เสีย',
      'not-found': 'ไม่พบไฟล์บน server',
      network: 'เชื่อมต่อไม่สำเร็จ ลองอีกครั้งได้',
      disk: 'เขียนไฟล์ไม่ได้ ตรวจพื้นที่ว่างและสิทธิ์ของโฟลเดอร์',
      'size-mismatch': 'ขนาดไฟล์ไม่ตรงกับที่ server แจ้ง',
      server: 'Server ตอบกลับผิดปกติ',
      engine: 'ตัวดาวน์โหลดหยุดทำงาน ลองเปิดโปรแกรมใหม่',
      'video-drm': 'วิดีโอนี้มี DRM จึงโหลดไม่ได้',
      'video-unsupported': 'ไม่พบวิดีโอที่โหลดได้ในหน้านี้ หรือเป็นการถ่ายทอดสด',
      'video-login': 'วิดีโอนี้ต้องล็อกอินก่อน ซึ่งโปรแกรมยังไม่รองรับ',
    },
    pause: 'หยุด',
    resume: 'โหลดต่อ',
    more: 'ตัวเลือกเพิ่มเติม',
    newLink: 'ใส่ลิงก์ใหม่',
    useLink: 'ใช้ลิงก์นี้',
    newLinkLabel: 'วางลิงก์ใหม่ของไฟล์เดิม',
    retry: 'ลองอีกครั้ง',
    resumeAnyway: 'โหลดต่อแม้เสี่ยง',
    restart: 'เริ่มใหม่',
    openFile: 'เปิดไฟล์',
    showInFolder: 'เปิดโฟลเดอร์',
    removeFromList: 'เอาออกจากรายการ',
    moveToTrash: 'ย้ายไฟล์ไปถังขยะ',
    cancelAndDelete: 'ยกเลิกและลบไฟล์ที่โหลดค้าง',
    connectionUnit: 'connection',
    peersUnit: 'peer',
    remaining: 'เหลือ',
    started: 'เริ่ม',
    finished: 'เสร็จ',
    today: 'วันนี้',
    seconds: 'วินาที',
    minutes: 'นาที',
    hours: 'ชั่วโมง',
    files: (count) => `${count} ไฟล์`,
    emptyAllTitle: 'ยังไม่มีการดาวน์โหลด',
    emptyAllBody: 'วางลิงก์ด้านบน หรือกดดาวน์โหลดในเบราว์เซอร์ที่เชื่อมไว้',
    emptyActiveTitle: 'ไม่มีงานที่กำลังโหลด',
    emptyActiveBody: 'งานที่กำลังโหลดและหยุดชั่วคราวจะแสดงที่นี่',
    emptyCompletedTitle: 'ยังไม่มีไฟล์ที่โหลดเสร็จ',
    emptyCompletedBody: 'ไฟล์ที่โหลดเสร็จแล้วจะแสดงที่นี่',
    emptyProblemTitle: 'ไม่มีอะไรต้องดูแล',
    emptyProblemBody: 'งานที่ต้องการการตัดสินใจจากคุณจะแสดงที่นี่',
    emptyTypeTitle: 'ยังไม่มีไฟล์ชนิดนี้',
    emptyTypeBody: (category) => `ไฟล์ประเภท${category}จะแสดงที่นี่`,
    trayOpen: 'เปิด Speed Downloader',
    trayPauseAll: 'หยุดทั้งหมด',
    trayResumeAll: 'โหลดต่อทั้งหมด',
    trayQuit: 'ออกจากโปรแกรม',
    trayActive: (count, speed) => `กำลังโหลด ${count} ไฟล์ · ${speed}`,
    trayIdle: 'ไม่มีงานที่กำลังโหลด',
    trayProblems: (count) => `ต้องดูแล ${count} รายการ`,
    trayAddLink: (host) => `เพิ่มลิงก์จากคลิปบอร์ด: ${host}`,
    trayAddLinkNone: 'ไม่มีลิงก์ในคลิปบอร์ด',
    trayRecent: 'ไฟล์ล่าสุด',
    trayOpenFolder: 'เปิดโฟลเดอร์ดาวน์โหลด',
    trayCaptured: 'รับไฟล์จากเบราว์เซอร์แล้ว',
    trayHint: 'โปรแกรมยังทำงานอยู่ใน system tray ถ้าจะออกให้คลิกขวาที่ไอคอนแล้วเลือก ออกจากโปรแกรม',
    riskyTitle: (name) => `ไฟล์นี้เป็นโปรแกรมหรือสคริปต์: ${name}`,
    riskyDetail: 'เปิดเฉพาะเมื่อเชื่อถือแหล่งที่มาเท่านั้น',
    riskyOpen: 'เปิดไฟล์',
    riskyCancel: 'ไม่เปิด',
    torrentFilter: 'ไฟล์ Torrent',
    startFailed: 'เปิดโปรแกรมไม่สำเร็จ',
    errorInstalledOnly: 'ตั้งค่าได้เฉพาะตัวที่ติดตั้งแล้ว',
    fileMissingStatus: 'ไม่พบไฟล์',
    fileMissing: 'ไฟล์นี้ไม่อยู่ที่เดิมแล้ว อาจถูกย้ายหรือลบไป',
    downloadAgain: 'โหลดใหม่',
    errorOpenFile: 'เปิดไฟล์นี้ไม่ได้ เครื่องอาจยังไม่มีโปรแกรมที่เปิดไฟล์ชนิดนี้',
    errorOpenFolder: 'เปิดโฟลเดอร์นี้ไม่ได้ อาจถูกย้ายหรือลบไป',
    errorTrash: 'ย้ายไฟล์ไปถังขยะไม่ได้ ไฟล์อาจเปิดอยู่ในโปรแกรมอื่น',
    pickerOpen: 'หน้าต่างเลือกไฟล์เปิดอยู่แล้ว ดูได้ที่แถบงาน',
    closeNotice: 'ปิดข้อความนี้',
    errors: {
      'Invalid URL': 'ลิงก์นี้ไม่ถูกต้อง',
      'Unsupported address type': 'รองรับเฉพาะลิงก์ http, https และ magnet',
      'This magnet link has no valid BitTorrent hash.': 'ลิงก์ magnet นี้ไม่ถูกต้อง',
      'This is not a valid .torrent file.': 'ไฟล์นี้ไม่ใช่ไฟล์ .torrent ที่ใช้งานได้',
      'The schedule must start and end at different times.': 'เวลาเริ่มและเวลาหยุดต้องไม่ตรงกัน',
      'Video downloads are not available because yt-dlp is missing.': 'โหลดวิดีโอไม่ได้ เพราะไม่พบ yt-dlp',
      'Download not found.': 'ไม่พบรายการนี้แล้ว',
      'This file is not finished.': 'ไฟล์นี้ยังโหลดไม่เสร็จ',
    },
  },
  en: {
    locale: 'en-GB',
    searchPlaceholder: 'Find a file',
    noResultsTitle: 'No matching files',
    noResultsBody: 'Try a different search.',
    columnFile: 'File',
    columnSize: 'Size',
    columnProgress: 'Progress',
    addPlaceholder: 'Paste a link or magnet to download',
    addLabel: 'Link to download',
    addButton: 'Download',
    addVideo: 'Get video',
    addVideoNote: 'Paste the address of a video page, then press this. Works only for videos without DRM.',
    sectionSchedule: 'Schedule',
    scheduleEnabled: 'Download only during set hours',
    scheduleNote: 'Outside these hours downloads wait in the queue. The computer must be on and the app running.',
    scheduleStart: 'Start at',
    scheduleEnd: 'Stop at',
    waitingSchedule: (time) => `Waiting until ${time}`,
    startNow: 'Start now',
    skipOnce: 'Let the browser download once',
    skipOnceNote: 'Click the Speed Downloader icon on the browser toolbar. The next file within 1 minute stays in the browser.',
    openTorrent: 'Open .torrent file',
    filtersLabel: 'Filter the list',
    settings: 'Settings',
    done: 'Done',
    sectionDownloads: 'Downloads',
    sectionBrowser: 'Browser',
    sectionGeneral: 'General',
    saveTo: 'Save files to',
    saveToNote: 'Applies to newly added files. Files already started stay where they are.',
    shutdownWhenDone: 'Turn off the computer when done',
    shutdownNote: 'You get 60 seconds to cancel. It applies once and then turns itself off. Paused files are not waited for.',
    shutdownArmed: 'Will turn off when done',
    shutdownTitle: 'Downloads finished. The computer turns off in 60 seconds.',
    shutdownDetail: (failed) => (failed ? `${failed} ${failed === 1 ? 'file' : 'files'} failed or need a decision. ` : '') + 'If a program has unsaved work, Windows may wait for you before turning off.',
    shutdownCancel: 'Keep the computer on',
    shutdownNow: 'Turn off now',
    shutdownFailed: 'The computer could not be turned off.',
    sectionFolders: 'Folders by file type',
    foldersNote: 'Types without a folder here go to the main folder. Applies to newly added files.',
    useMainFolder: 'Uses the main folder',
    useMainFolderAction: 'Use main folder',
    allTypes: 'All types',
    typeFilterLabel: 'Filter by file type',
    backToDownloads: 'Back to downloads',
    change: 'Change',
    concurrent: 'Simultaneous downloads',
    connections: 'Connections per file',
    speedLimit: 'Speed limit',
    noLimit: 'No limit',
    perSecond: '/s',
    capture: 'Take downloads from the browser',
    extraTypes: 'Extra file types',
    extraPlaceholder: 'For example dat, nds',
    extraNote: 'Video, audio, documents, programs and archives are already included. Separate types with commas.',
    installExtension: 'Install the extension',
    installExtensionNote: 'Open chrome://extensions or edge://extensions, turn on Developer mode, click Load unpacked, then choose this folder.',
    openFolder: 'Open folder',
    autoStart: 'Start with Windows',
    autoStartNote: 'Runs quietly in the system tray',
    autoStartUnavailable: 'Available once the app is installed',
    language: 'Language',
    filterAll: 'All',
    filterActive: 'In progress',
    filterCompleted: 'Completed',
    filterProblem: 'Needs attention',
    categories: { video: 'Video', audio: 'Audio', document: 'Documents', program: 'Programs', archive: 'Archives', other: 'Other' },
    status: { queued: 'Queued', probing: 'Checking file', downloading: 'Downloading', paused: 'Paused', completed: 'Completed', attention: 'Needs a decision', failed: 'Failed' },
    problems: {
      'link-expired': 'The server refused this link. It may have expired or need a new login. Add a new link to continue from where it stopped.',
      'remote-changed': 'The file on the server has changed. Continuing would corrupt it, so it has to start again.',
      'cannot-verify': 'The server gives no way to check the file is unchanged. Continuing could produce a corrupt file.',
      'not-found': 'The file was not found on the server.',
      network: 'The connection failed. You can try again.',
      disk: 'The file could not be written. Check free space and folder permissions.',
      'size-mismatch': 'The file size does not match what the server reported.',
      server: 'The server sent an unexpected response.',
      engine: 'The download engine stopped. Try reopening the app.',
      'video-drm': 'This video has DRM, so it cannot be downloaded.',
      'video-unsupported': 'No downloadable video was found on this page, or it is a live stream.',
      'video-login': 'This video needs a login, which the app does not support yet.',
    },
    pause: 'Pause',
    resume: 'Resume',
    more: 'More options',
    newLink: 'Add new link',
    useLink: 'Use this link',
    newLinkLabel: 'Paste a new link to the same file',
    retry: 'Try again',
    resumeAnyway: 'Continue anyway',
    restart: 'Start again',
    openFile: 'Open file',
    showInFolder: 'Show in folder',
    removeFromList: 'Remove from list',
    moveToTrash: 'Move file to Recycle Bin',
    cancelAndDelete: 'Cancel and delete partial file',
    connectionUnit: 'connections',
    peersUnit: 'peers',
    remaining: '',
    started: 'Started',
    finished: 'Finished',
    today: 'Today',
    seconds: 's left',
    minutes: 'min left',
    hours: 'h left',
    files: (count) => (count === 1 ? '1 file' : `${count} files`),
    emptyAllTitle: 'No downloads yet',
    emptyAllBody: 'Paste a link above, or start a download in a connected browser.',
    emptyActiveTitle: 'Nothing in progress',
    emptyActiveBody: 'Running and paused downloads appear here.',
    emptyCompletedTitle: 'No completed files yet',
    emptyCompletedBody: 'Finished downloads appear here.',
    emptyProblemTitle: 'Nothing needs attention',
    emptyProblemBody: 'Downloads that need a decision from you appear here.',
    emptyTypeTitle: 'No files of this type yet',
    emptyTypeBody: (category) => `${category} files appear here.`,
    trayOpen: 'Open Speed Downloader',
    trayPauseAll: 'Pause all',
    trayResumeAll: 'Resume all',
    trayQuit: 'Quit',
    trayActive: (count, speed) => `Downloading ${count === 1 ? '1 file' : `${count} files`} · ${speed}`,
    trayIdle: 'Nothing downloading',
    trayProblems: (count) => `${count} need attention`,
    trayAddLink: (host) => `Add link from clipboard: ${host}`,
    trayAddLinkNone: 'No link on the clipboard',
    trayRecent: 'Recent files',
    trayOpenFolder: 'Open downloads folder',
    trayCaptured: 'Download taken from the browser',
    trayHint: 'The app is still running in the system tray. To exit, right-click the icon and choose Quit.',
    riskyTitle: (name) => `This file is a program or script: ${name}`,
    riskyDetail: 'Only open it if you trust where it came from.',
    riskyOpen: 'Open file',
    riskyCancel: 'Do not open',
    torrentFilter: 'Torrent files',
    startFailed: 'The app could not start',
    errorInstalledOnly: 'This setting is available once the app is installed.',
    fileMissingStatus: 'File not found',
    fileMissing: 'This file is no longer where it was saved. It may have been moved or deleted.',
    downloadAgain: 'Download again',
    errorOpenFile: 'This file could not be opened. There may be no program for this type of file.',
    errorOpenFolder: 'This folder could not be opened. It may have been moved or deleted.',
    errorTrash: 'This file could not be moved to the Recycle Bin. Another program may have it open.',
    pickerOpen: 'A file picker is already open. You can find it on the taskbar.',
    closeNotice: 'Close this message',
    errors: {
      'Invalid URL': 'This link is not valid.',
      'Unsupported address type': 'Only http, https and magnet links work here.',
    },
  },
};

export function defaultLanguage(systemLocale: string): Language {
  return systemLocale.toLowerCase().startsWith('th') ? 'th' : 'en';
}
