/**
 * api.mjs — the TryClear API, v2 (https://api.tryclear.io/v2), as this server calls it.
 *
 * The routes, and every word they answer with, are the API's own:
 *
 *   POST /v2/check                "have you read this picture?" The SHA-256, never the picture
 *   POST /v2/lookup               what memory has seen of an address or a sender
 *   POST /v2/eval                 "I have a picture": a read's ID and a one-time form
 *   POST <the form's url>         the file itself, straight to the bucket, with no key
 *   POST /v2/eval/{iovi_id}/read  "the file is there: read it"
 *   GET  /v2/eval/{iovi_id}       how the read is going, and its answer once it's done
 *
 * A caller who's turned away gets one fixed word and a short message. Here each word becomes
 * a Refused: a plain sentence for the agent, never a crash and never the API's own text. A 429
 * with no word is API Gateway's throttle, not a limit: it's tried again after a moment.
 *
 * The key goes in the Authorization header to the API and nowhere else: never to the bucket,
 * and never into a sentence.
 */

import { createRequire } from 'node:module';

export const DEFAULT_API = 'https://api.tryclear.io/v2';
export const VERSION = createRequire(import.meta.url)('../package.json').version;

const REQUEST_MS = 30_000;          // one call to the API
const UPLOAD_MS = 120_000;          // sending a file of up to 10 MB
const THROTTLE_WAITS = [500, 1_000, 2_000];   // a throttled call is tried again after each of these

/** A plain answer instead of a result: why, as a word, the sentence for the agent, and any numbers. */
export class Refused extends Error {
  constructor(kind, message, more = {}) {
    super(message);
    this.kind = kind;
    this.more = more;
  }
}

const KEY_HELP = 'Make one in your account settings at https://tryclear.io (a free account works), and put it in '
  + "TRYCLEAR_API_KEY in this MCP server's settings.";

/** The plain answer when there's no key at all. */
export const NO_KEY = new Refused('no_api_key', `TryClear needs an API key, and TRYCLEAR_API_KEY isn't set. ${KEY_HELP}`);

/**
 * The settings, from the environment: the address, the key and whether reads are marked as tests. The key is
 * TRYCLEAR_API_KEY's, or, when that isn't set, CLEAR_API_KEY's: the name 0.2 read, so someone moved to 1.0 by
 * npm's tag keeps the key they set. keyName says which, for the sentence when TryClear doesn't accept it.
 */
export function settings(env = process.env) {
  const given = (env.TRYCLEAR_API_KEY ?? '').trim() || null;
  const old = given ? null : (env.CLEAR_API_KEY ?? '').trim() || null;
  const apiUrl = ((env.TRYCLEAR_API_URL ?? '').trim() || DEFAULT_API).replace(/\/+$/, '');
  const testReads = ['1', 'true', 'yes'].includes((env.TRYCLEAR_TEST_READS ?? '').trim().toLowerCase());
  return { apiKey: given ?? old, keyName: old ? 'CLEAR_API_KEY' : 'TRYCLEAR_API_KEY', apiUrl, testReads };
}

/** The sentence for a limit that was reached, by which limit it was (the reply's `reached` and `limit`). */
function limitSentence(body) {
  const limit = Number.isInteger(body.limit) ? body.limit : null;
  const reached = body.reached ?? (body.quota?.reached === 'monthly' ? 'plan_month' : body.quota?.reached === 'daily' ? 'plan_day' : null);
  const n = (unit) => (limit === null ? '' : ` (${limit.toLocaleString('en-US')} ${unit})`);
  const others = ' check_picture and lookup still work: they never use a read.';
  switch (body.error === 'check_limit' ? 'check_limit' : reached) {
    case 'check_limit':
      return `That's today's limit for checks and lookups on this account${n('a day')}. They start again at midnight UTC.`;
    case 'plan_day':
      return `That's all of today's reads for this account${n('a day')}. They start again at midnight UTC.${others}`;
    case 'plan_month':
      return `That's all of this month's reads for this account${n('a month')}. They start again on the 1st, UTC.${others}`;
    case 'visitor_day':
      return `That's today's reads for this network${n('a day')}. They start again at midnight UTC.${others}`;
    case 'visitor_month':
      return `That's this month's reads for this network${n('a month')}.${others}`;
    case 'visitors_day':
      return `TryClear has reached today's limit for visitors${n('a day')}. Come back tomorrow.${others}`;
    default:
      return `That's the limit for this account for now. Try again later.${others}`;
  }
}

/** The Refused for one of the API's error words, or for a reply with none. */
function refusalFor(status, body, route, keyName = 'TRYCLEAR_API_KEY') {
  const word = typeof body?.error === 'string' ? body.error : null;
  if (status === 429 && !word) return new Refused('busy', 'TryClear is busy right now. Try again in a moment.');
  if (status === 429) {
    return new Refused(word, limitSentence(body), { reached: body.reached ?? null, limit: body.limit ?? null });
  }
  switch (status === 401 ? 'unauthorized' : word) {
    case 'unauthorized':
      return new Refused(word, `TryClear didn't accept the API key in ${keyName}. ${KEY_HELP}`);
    case 'test_not_allowed':
      return new Refused(word, "TRYCLEAR_TEST_READS is on, and only TryClear's own account can mark a read as a test. "
        + 'Turn it off to read this picture. Nothing was read.');
    case 'empty':
      return new Refused(word, "The file is empty, so there's nothing to read.");
    case 'too_big':
      return new Refused(word, 'The file is over 10 MB. TryClear reads pictures of 10 MB at most.');
    case 'not_an_image':
      return new Refused(word, "TryClear reads pictures made of pixels (PNG, JPEG, GIF, WebP, TIFF, BMP or HEIC). It doesn't read an SVG.");
    case 'no_key':
      return new Refused(word, "That can't be looked up: it isn't a link, a phone number or an e-mail address TryClear can write the standard way.");
    case 'quota_check_unavailable':
      return new Refused(word, "TryClear couldn't count this just now. Try again shortly.");
    case 'not_found':
      return new Refused(word, 'TryClear has no such read for this key.');
    case 'not_uploaded':
      return new Refused(word, "The picture didn't reach TryClear. Try again.");
    case 'trial_expired':
    case 'sign_in_required':
      return new Refused(word, `TryClear wants a key for this. ${KEY_HELP}`);
    case 'bad_request':
      return new Refused(word, "TryClear couldn't read this server's request. Nothing was read. Updating @trycleario/mcp-server may fix it.");
    default:
      break;
  }
  if (status === 403 && !word) {
    return new Refused('no_route', `TryClear's API has nothing at ${route}. Check TRYCLEAR_API_URL, or leave it unset.`);
  }
  return new Refused('failed', "Something went wrong on TryClear's side. Nothing was read. Try again later.", { status });
}

export class Api {
  /**
   * apiUrl: the API's address, ending /v2. apiKey: the person's key, and keyName the setting it came from.
   * fetch and sleep can be handed in, so the tests can run on a stand-in's clock.
   */
  constructor({ apiUrl = DEFAULT_API, apiKey, keyName = 'TRYCLEAR_API_KEY', fetch = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.keyName = keyName;
    this.fetch = fetch;
    this.sleep = sleep;
  }

  /** One call to the API. The reply's JSON, or a Refused. */
  async call(method, route, body) {
    const url = `${this.apiUrl}${route}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': `tryclear-mcp/${VERSION}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_MS),
        });
      } catch {
        throw new Refused('unreachable', `TryClear can't be reached at ${this.apiUrl}. Check the connection and try again.`);
      }
      let reply = null;
      try {
        reply = await res.json();
      } catch {
        // not JSON: API Gateway's own pages, or a proxy's
      }
      if (res.ok && reply !== null && typeof reply === 'object') return reply;
      const refused = res.ok ? new Refused('failed', "TryClear's answer couldn't be read. Try again later.") : refusalFor(res.status, reply, route, this.keyName);
      if (refused.kind === 'busy' && attempt < THROTTLE_WAITS.length) {
        await this.sleep(THROTTLE_WAITS[attempt]);
        continue;
      }
      throw refused;
    }
  }

  /** POST /v2/check: the check response (lane hash, fingerprint or none). */
  check(sha256) {
    return this.call('POST', '/check', { sha256 });
  }

  /** POST /v2/lookup: { address } or { sender }. The lookup response. */
  lookup(asked) {
    return this.call('POST', '/lookup', asked);
  }

  /** POST /v2/eval: the status reply, with `upload` when the file can be sent, or status "off". */
  ask({ filename, size, contentType, test }) {
    return this.call('POST', '/eval', { filename, size, content_type: contentType, ...(test ? { test: true } : {}) });
  }

  /** POST /v2/eval/{iovi_id}/read: the first status. */
  readIt(id) {
    return this.call('POST', `/eval/${encodeURIComponent(id)}/read`);
  }

  /** GET /v2/eval/{iovi_id}: the status, and the answer once it's done. */
  status(id) {
    return this.call('GET', `/eval/${encodeURIComponent(id)}`);
  }

  /**
   * The file, to the bucket, with the ask's one-time form: every field as given, the file last,
   * and no Authorization header (the form is the permission). Success is 204.
   */
  async upload(upload, picture) {
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields ?? {})) form.append(name, value);
    form.append('file', new Blob([picture.bytes], { type: picture.type }), picture.name);
    let res;
    try {
      res = await this.fetch(upload.url, { method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_MS) });
    } catch {
      throw new Refused('unreachable', "The picture couldn't be sent to TryClear. Check the connection and try again.");
    }
    if (res.ok) return;
    const code = /<Code>([^<]+)<\/Code>/.exec(await res.text().catch(() => ''))?.[1] ?? null;
    if (code === 'EntityTooLarge') throw new Refused('too_big', 'The file is over 10 MB. TryClear reads pictures of 10 MB at most.');
    if (res.status === 403) throw new Refused('upload_expired', 'The form for sending the picture ran out before it was sent. Try again.');
    throw new Refused('upload_failed', `The picture couldn't be sent to TryClear (${res.status}${code ? `, ${code}` : ''}). Try again.`);
  }
}
