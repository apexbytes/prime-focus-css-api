import net from 'node:net';
import { antivirusDriver, env } from '../../config/index.js';
import { createModuleLogger } from '../logger/index.js';

const log = createModuleLogger('antivirus');

/**
 * What a scan concluded.
 *
 * `skipped` is a first-class outcome, not a failure: with no scanner configured
 * nothing looked at the file, and recording it as `clean` would put a claim in
 * front of an agent that no code in this system can support.
 */
export type ScanVerdict = 'clean' | 'infected' | 'skipped' | 'failed';

export interface ScanResult {
  verdict: ScanVerdict;
  /** The malware name clamd reported, for the quarantine record. */
  signature?: string;
  /** Why a scan came back `skipped` or `failed`, in words. */
  reason?: string;
}

/**
 * Parses one clamd reply line.
 *
 * Exported for its own unit test: the protocol is three shapes of one line, and
 * getting `FOUND` wrong in either direction is the whole risk in this file —
 * treating an infected file as clean, or quarantining a customer's bank
 * statement because a reply was misread.
 */
export function parseClamReply(reply: string): ScanResult {
  const line = reply.replace(/\0/g, '').trim();

  if (/\bOK$/.test(line)) return { verdict: 'clean' };

  const found = /^(?:stream:\s*)?(.+?)\s+FOUND$/.exec(line);
  if (found?.[1]) return { verdict: 'infected', signature: found[1].trim() };

  const error = /^(?:stream:\s*)?(.+?)\s+ERROR$/.exec(line);
  if (error?.[1]) return { verdict: 'failed', reason: error[1].trim() };

  // An unrecognised reply is not an all-clear. A new clamd version wording
  // something differently must not silently pass malware through.
  return { verdict: 'failed', reason: `unrecognised clamd reply: ${line || '(empty)'}` };
}

/**
 * Scans bytes for malware.
 *
 * Buffers rather than streams: the caller has already read the object to hand it
 * over, attachments are capped well below the size where streaming would matter,
 * and a buffer keeps the INSTREAM framing below simple enough to be obviously
 * correct.
 */
export async function scanBuffer(buffer: Buffer): Promise<ScanResult> {
  if (antivirusDriver === 'none') {
    return { verdict: 'skipped', reason: 'no scanner is configured' };
  }

  if (buffer.byteLength === 0) {
    return { verdict: 'skipped', reason: 'nothing to scan' };
  }

  if (buffer.byteLength > env.ANTIVIRUS_MAX_BYTES) {
    // clamd would drop the connection mid-stream, which reads as an outage
    // rather than as the size limit it is.
    return {
      verdict: 'skipped',
      reason: `file is larger than the scanner accepts (${buffer.byteLength} bytes)`,
    };
  }

  try {
    return parseClamReply(await instream(buffer));
  } catch (error) {
    // A scanner outage must not be reported as a clean file, and must not lose
    // the attachment either: the job records `failed` and pg-boss retries it.
    const reason = error instanceof Error ? error.message : 'unknown error';
    log.error('virus scan failed', { err: error });
    return { verdict: 'failed', reason };
  }
}

/**
 * clamd's `INSTREAM` command over TCP.
 *
 * The wire format is a null-terminated command, then chunks each prefixed with
 * their length as a 4-byte big-endian integer, then a zero-length chunk to mark
 * the end. `z`-prefixing the command asks clamd to null-terminate its reply,
 * which is what makes the end of the reply unambiguous.
 */
function instream(buffer: Buffer): Promise<string> {
  const CHUNK_SIZE = 64 * 1024;

  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({
      host: env.ANTIVIRUS_HOST as string,
      port: env.ANTIVIRUS_PORT,
    });

    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (error: Error | null, reply?: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(reply ?? '');
    };

    socket.setTimeout(env.ANTIVIRUS_TIMEOUT_MS);
    socket.on('timeout', () => finish(new Error('clamd did not answer in time')));
    socket.on('error', (error) => finish(error));
    socket.on('data', (data: Buffer) => {
      chunks.push(data);
      // clamd answers once and closes; the null terminator says the line is
      // complete without waiting for the socket to go away.
      if (data.includes(0)) finish(null, Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');

      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
        const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(chunk.byteLength, 0);
        socket.write(header);
        socket.write(chunk);
      }

      socket.write(Buffer.from([0, 0, 0, 0]));
    });
  });
}

export interface AntivirusHealth {
  state: 'ok' | 'unavailable' | 'not_configured';
  error?: string;
}

/**
 * Readiness probe. `none` reports `not_configured` rather than `ok`, following
 * the queue's `inline` driver: the process is serviceable, but an operator
 * reading `/readyz` should be able to see that nothing is scanning uploads.
 */
export async function checkAntivirus(): Promise<AntivirusHealth> {
  if (antivirusDriver === 'none') return { state: 'not_configured' };

  try {
    const reply = await ping();
    return reply.includes('PONG')
      ? { state: 'ok' }
      : { state: 'unavailable', error: `unexpected reply: ${reply}` };
  } catch (error) {
    return { state: 'unavailable', error: error instanceof Error ? error.message : 'unknown' };
  }
}

function ping(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({
      host: env.ANTIVIRUS_HOST as string,
      port: env.ANTIVIRUS_PORT,
    });

    let settled = false;
    const finish = (error: Error | null, reply?: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(reply ?? '');
    };

    // Deliberately shorter than a scan: a readiness probe that hangs for the
    // scan timeout would make the whole probe time out.
    socket.setTimeout(Math.min(env.ANTIVIRUS_TIMEOUT_MS, env.READINESS_CHECK_TIMEOUT_MS));
    socket.on('timeout', () => finish(new Error('clamd did not answer in time')));
    socket.on('error', (error) => finish(error));
    socket.on('data', (data: Buffer) => finish(null, data.toString('utf8')));
    socket.on('connect', () => socket.write('zPING\0'));
  });
}

export { antivirusDriver };
