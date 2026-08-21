import { describe, expect, it } from 'vitest';
import { parseClamReply } from './index.js';

/**
 * The clamd reply is one line, and misreading it fails in both directions: a
 * missed `FOUND` hands malware to an agent, a misread `OK` quarantines a
 * customer's bank statement. Hence a test per shape of the line.
 */
describe('parseClamReply', () => {
  it('reads a clean verdict', () => {
    expect(parseClamReply('stream: OK\0')).toEqual({ verdict: 'clean' });
  });

  it('reads an infection and keeps the signature for the quarantine record', () => {
    expect(parseClamReply('stream: Eicar-Signature FOUND\0')).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Signature',
    });
  });

  it('handles a signature containing spaces', () => {
    expect(parseClamReply('stream: Win.Test.EICAR_HDB-1 FOUND')).toEqual({
      verdict: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('reads a scanner-side error as failed, not as clean', () => {
    const result = parseClamReply('stream: size limit exceeded ERROR\0');
    expect(result.verdict).toBe('failed');
    expect(result.reason).toBe('size limit exceeded');
  });

  it('treats an unrecognised reply as failed rather than as an all-clear', () => {
    // A future clamd wording something differently must not pass malware
    // through as clean.
    expect(parseClamReply('stream: something new').verdict).toBe('failed');
    expect(parseClamReply('').verdict).toBe('failed');
  });

  it('does not mistake a filename ending in OK for a clean verdict', () => {
    // `FOUND` is matched before the OK suffix, so a signature is never lost.
    expect(parseClamReply('stream: Trojan.OK FOUND').verdict).toBe('infected');
  });
});
