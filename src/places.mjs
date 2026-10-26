/**
 * places.mjs — where a person's pictures are on this computer, so nobody has to type where a file is.
 *
 *   folders()               The folders, for this computer: where screenshots save, the Desktop, Downloads,
 *                           Documents and Pictures. On a Mac, screenshots go where the person set them
 *                           (`defaults read com.apple.screencapture location`), or the Desktop. On Windows,
 *                           Pictures\Screenshots (and OneDrive's). On Linux, Pictures/Screenshots and
 *                           Pictures, from the XDG user folders. Only folders that are there.
 *   latestPicture()         The newest picture straight inside the screenshots folders, the Desktop and
 *                           Downloads: "my latest screenshot".
 *   findPictures(name)      Pictures whose file name has every word of `name`, in Desktop, Downloads,
 *                           Documents, Pictures and the screenshots folders, and the folders inside them.
 *
 * A picture is a file named like one TryClear reads (PNG, JPEG, GIF, WebP, TIFF, BMP, HEIC). What it
 * really is, is picture.mjs's to say when it's opened. Hidden files and folders are never looked at,
 * and neither are links to other folders, apps, libraries and code folders (node_modules and the
 * like). Nothing here sends anything anywhere.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** File names TryClear reads. An SVG is code, so it's never one. */
export const PICTURE_NAME = /\.(png|jpe?g|gif|webp|tiff?|bmp|heic|heif)$/i;

/** Folders a search never goes into: code, apps and libraries, where a person's own picture isn't. */
const NEVER_INTO = /^(node_modules|__pycache__|site-packages|venv|\.venv|Library|AppData|.*\.(app|photoslibrary|bundle|framework|lproj))$/i;

/** Words in a name that say nothing about which file it is ("the Notion one"). */
const FILLER = new Set(['the', 'a', 'an', 'one', 'my', 'that', 'this', 'on', 'in', 'at', 'of', 'from', 'called', 'named']);

const SEARCH_DEPTH = 6;          // folders inside folders, at most this deep
const SEARCH_ENTRIES = 60_000;   // the most files and folders one search looks at
const SEARCH_MS = 4_000;         // and the longest it takes
export const MOST_MATCHES = 10;  // the most matches one search gives back

/** The Mac's screenshot setting, or null when it isn't set: `defaults read com.apple.screencapture location`. */
function macScreenshotSetting() {
  return new Promise((resolve) => {
    execFile('defaults', ['read', 'com.apple.screencapture', 'location'], { timeout: 2_000 }, (error, out) => {
      resolve(error ? null : String(out).trim() || null);
    });
  });
}

/** Linux's XDG user folders (~/.config/user-dirs.dirs): { DESKTOP, DOWNLOAD, DOCUMENTS, PICTURES } as set there. */
async function xdgFolders(home, env, readText) {
  const config = env.XDG_CONFIG_HOME || path.posix.join(home, '.config');
  let text = '';
  try {
    text = await readText(path.posix.join(config, 'user-dirs.dirs'));
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*XDG_([A-Z]+)_DIR\s*=\s*"(.*)"\s*$/);
    if (m) out[m[1]] = m[2].replace(/^\$HOME(?=\/|$)/, home);
  }
  return out;
}

/**
 * This computer's picture folders: { screenshots, desktop, downloads, documents, pictures }, each a list
 * of folders that are there, and `home`. Everything it reads can be handed in, so a test can be any computer.
 */
export async function folders({ platform = process.platform, home = homedir(), env = process.env,
  screenshotSetting = macScreenshotSetting, readText = (file) => readFile(file, 'utf8'), isFolder = isAFolder } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const at = (...parts) => p.join(home, ...parts);
  let found;
  if (platform === 'darwin') {
    const setting = await screenshotSetting();
    const shots = setting ? (setting === '~' || setting.startsWith('~/') ? p.join(home, setting.slice(1)) : setting) : at('Desktop');
    found = { screenshots: [shots], desktop: [at('Desktop')], downloads: [at('Downloads')], documents: [at('Documents')],
      pictures: [at('Pictures')] };
  } else if (platform === 'win32') {
    const onedrive = env.OneDrive || env.OneDriveConsumer || env.OneDriveCommercial || at('OneDrive');
    found = {
      screenshots: [at('Pictures', 'Screenshots'), p.join(onedrive, 'Pictures', 'Screenshots')],
      desktop: [at('Desktop'), p.join(onedrive, 'Desktop')],
      downloads: [at('Downloads')],
      documents: [at('Documents'), p.join(onedrive, 'Documents')],
      pictures: [at('Pictures'), p.join(onedrive, 'Pictures')],
    };
  } else {
    const xdg = await xdgFolders(home, env, readText);
    const pictures = xdg.PICTURES || at('Pictures');
    found = {
      screenshots: [p.join(pictures, 'Screenshots'), pictures],
      desktop: [xdg.DESKTOP || at('Desktop')],
      downloads: [xdg.DOWNLOAD || at('Downloads')],
      documents: [xdg.DOCUMENTS || at('Documents')],
      pictures: [pictures],
    };
  }
  const out = { home };
  for (const [kind, list] of Object.entries(found)) {
    const there = [];
    for (const folder of list) if (!there.includes(folder) && (await isFolder(folder))) there.push(folder);
    out[kind] = there;
  }
  return out;
}

async function isAFolder(folder) {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/** When a file came to be here: the later of when it was made and when it last changed. */
const whenOf = (info) => Math.max(info.birthtimeMs || 0, info.mtimeMs || 0);

/** A picture as a tool shows it: its name, where it is (from home, as ~/…), its full path and when. */
function shown(file, info, home) {
  const inHome = home && (file === home || file.startsWith(home + path.sep) || file.startsWith(home + '/'));
  return {
    name: path.basename(file),
    where: inHome ? `~${file.slice(home.length).replaceAll('\\', '/')}` : file,
    path: file,
    saved_at: new Date(whenOf(info)).toISOString(),
    size: info.size,
  };
}

/** The pictures straight inside `folder` (not the folders in it), with their file info. */
async function picturesIn(folder) {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !PICTURE_NAME.test(entry.name)) continue;
    const file = path.join(folder, entry.name);
    try {
      out.push({ file, info: await stat(file) });
    } catch {
      // gone since the folder was read
    }
  }
  return out;
}

/**
 * The newest picture straight inside the screenshots folders, the Desktop and Downloads, or null when
 * there's none: { name, where, path, saved_at, size, folder }. `folder` says which of those it's in.
 */
export async function latestPicture(places) {
  let best = null;
  for (const [kind, label] of [['screenshots', 'screenshots folder'], ['desktop', 'Desktop'], ['downloads', 'Downloads']]) {
    for (const folder of places[kind] ?? []) {
      for (const { file, info } of await picturesIn(folder)) {
        if (!best || whenOf(info) > whenOf(best.info)) best = { file, info, label };
      }
    }
  }
  if (!best) return null;
  return { ...shown(best.file, best.info, places.home), folder: best.label };
}

/** The words of a name, as they're matched: small letters and digits, and no filler words. */
export function wordsOf(name) {
  const words = String(name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const meaningful = words.filter((word) => !FILLER.has(word));
  return meaningful.length ? meaningful : words;
}

const FOLDER_KINDS = { desktop: ['desktop'], downloads: ['downloads'], documents: ['documents'], pictures: ['pictures', 'screenshots'],
  screenshots: ['screenshots'] };

/**
 * Pictures whose file name holds every word of `name`, in any letter case and order, with or without
 * the marks between them ("notion bad url" finds Notion_BadURL.png). In Desktop, Downloads, Documents,
 * Pictures and the screenshots folders, or only in `where` (desktop, downloads, documents, pictures or
 * screenshots), and the folders inside them. Newest first, MOST_MATCHES at most:
 * { matches, more, searched_all }. `more` is how many others matched; searched_all is false when the
 * search stopped at its limits before looking everywhere.
 */
export async function findPictures(name, places, { where = null, now = () => Date.now() } = {}) {
  const words = wordsOf(name);
  if (words.length === 0) return { matches: [], more: 0, searched_all: true, words };
  const kinds = where ? FOLDER_KINDS[where] ?? [] : ['screenshots', 'desktop', 'downloads', 'documents', 'pictures'];
  const roots = [...new Set(kinds.flatMap((kind) => places[kind] ?? []))];
  const seen = new Set();
  const hits = [];
  let looked = 0;
  let complete = true;
  const until = now() + SEARCH_MS;
  const queue = roots.map((folder) => ({ folder, depth: 0 }));
  while (queue.length) {
    const { folder, depth } = queue.shift();
    if (seen.has(folder)) continue;
    seen.add(folder);
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++looked > SEARCH_ENTRIES || now() > until) {
        complete = false;
        queue.length = 0;
        break;
      }
      if (entry.name.startsWith('.')) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < SEARCH_DEPTH && !NEVER_INTO.test(entry.name)) queue.push({ folder: file, depth: depth + 1 });
        else if (depth >= SEARCH_DEPTH) complete = false;
        continue;
      }
      if (!entry.isFile() || !PICTURE_NAME.test(entry.name)) continue;
      const plain = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!words.every((word) => plain.includes(word))) continue;
      try {
        hits.push({ file, info: await stat(file) });
      } catch {
        // gone since the folder was read
      }
    }
  }
  hits.sort((a, b) => whenOf(b.info) - whenOf(a.info));
  return { matches: hits.slice(0, MOST_MATCHES).map(({ file, info }) => shown(file, info, places.home)),
    more: Math.max(0, hits.length - MOST_MATCHES), searched_all: complete, words };
}

/** How long ago a time was, in plain words. */
export function ago(iso, now = Date.now()) {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} days ago`;
  return `on ${iso.slice(0, 10)}`;
}
