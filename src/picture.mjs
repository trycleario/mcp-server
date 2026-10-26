/**
 * picture.mjs — the picture file on the person's own machine.
 *
 * Reads the file, works out its SHA-256 and says what kind of picture it is, all here, before
 * anything is sent. What kind it is comes from the file's content, by TryClear's own rule: PNG,
 * JPEG, GIF, WebP, TIFF, BMP and HEIC are read, an SVG never is, and anything else isn't a
 * picture. So a file that isn't a picture is never sent, whatever it's called, and a read
 * TryClear would refuse doesn't use one of the person's reads. The size limits and pixel limits
 * past that are TryClear's to say.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** The most a file may be: TryClear's own limit. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** What each kind is sent as. Only an SVG's type is ever looked at by the API, to refuse it. */
const TYPES = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  tiff: 'image/tiff', bmp: 'image/bmp', heic: 'image/heic',
};

/** A picture the person's file can't be: why, as a word, and the sentence that says it. */
export class NotAPicture extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const startsWith = (data, bytes) => bytes.every((byte, i) => data[i] === byte);
const ascii = (data, from, to) => Buffer.from(data.subarray(from, to)).toString('latin1');

/**
 * The kind of picture, from the file's content alone: "png", "jpeg", "gif", "webp", "tiff",
 * "bmp", "heic" or "svg". Null when it's none of those. TryClear tells them apart the same way,
 * in the same order.
 */
export function kindOf(data) {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return 'webp';
  if (ascii(data, 0, 4) === 'II*\0' || ascii(data, 0, 4) === 'MM\0*') return 'tiff';
  if (ascii(data, 0, 2) === 'BM') return 'bmp';
  if (data.length >= 12 && ascii(data, 4, 8) === 'ftyp') {
    const brand = ascii(data, 8, 12).toLowerCase();
    if (brand.includes('heic') || brand.includes('heif') || brand.includes('mif1')) return 'heic';
    if (data.length >= 24) {
      const brands = ascii(data, 8, 24).toLowerCase();
      if (brands.includes('heic') || brands.includes('heif')) return 'heic';
    }
  }
  const head = Buffer.from(data.subarray(0, 500)).toString('utf8').toLowerCase().trim();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

/** The path as the person means it: ~ is their home, and a relative path is from where the server was started. */
export function where(given) {
  const plain = String(given ?? '').trim();
  if (plain === '~' || plain.startsWith('~/')) return path.join(homedir(), plain.slice(1));
  return path.resolve(plain);
}

const SVG_NAME = /\.svgz?$/i;
const READ_KINDS = 'PNG, JPEG, GIF, WebP, TIFF, BMP or HEIC';

/**
 * The picture at `given`, ready to check or send: { path, name, bytes, size, kind, type, sha256 }.
 * Throws NotAPicture, with a sentence the person can act on, for anything TryClear won't read.
 */
export async function openPicture(given) {
  if (typeof given !== 'string' || !given.trim()) {
    throw new NotAPicture('no_path', 'Say which picture: the newest screenshot (latest: true), or one find_picture finds by its name.');
  }
  const file = where(given);
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new NotAPicture('no_file', `There's no picture at ${file}. find_picture finds one by the words of its name.`);
    }
    throw new NotAPicture('unopenable', `${file} couldn't be opened (${error?.code ?? 'error'}).`);
  }
  if (info.isDirectory()) throw new NotAPicture('folder', `${file} is a folder, not a picture. find_picture finds a picture in it by its name.`);
  if (!info.isFile()) throw new NotAPicture('not_a_file', `${file} isn't a file.`);
  if (info.size === 0) throw new NotAPicture('empty', `${file} is empty, so there's nothing to read.`);
  if (info.size > MAX_FILE_BYTES) {
    const mb = (info.size / 1024 / 1024).toFixed(1);
    throw new NotAPicture('too_big', `${file} is ${mb} MB. TryClear reads pictures of 10 MB at most.`);
  }
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(file));
  } catch (error) {
    throw new NotAPicture('unopenable', `${file} couldn't be opened (${error?.code ?? 'error'}).`);
  }
  const kind = kindOf(bytes);
  if (kind === 'svg' || SVG_NAME.test(file)) {
    throw new NotAPicture('not_an_image',
      `${file} is an SVG. TryClear reads pictures made of pixels (${READ_KINDS}). An SVG is code, so TryClear doesn't read it.`);
  }
  if (kind === null) {
    throw new NotAPicture('not_an_image', `${file} isn't a ${READ_KINDS} picture, so TryClear doesn't read it. Nothing was sent.`);
  }
  return {
    path: file,
    name: path.basename(file),
    bytes,
    size: bytes.length,
    kind,
    type: TYPES[kind],
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
