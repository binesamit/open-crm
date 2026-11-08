// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { pickRecordingType, recordingExtension, recordingName } from './VoiceRecorder';

/** what a voice message is recorded as and named. */
describe('recording type and name', () => {
  it('WebM / Opus where supported, else what the browser has (Safari: MP4)', () => {
    expect(pickRecordingType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickRecordingType((x) => x === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecordingType(() => false)).toBeNull();
  });
  it('the extension follows the type; the name is sortable and safe', () => {
    expect(recordingExtension('audio/mp4')).toBe('m4a');
    expect(recordingExtension('audio/ogg')).toBe('ogg');
    expect(recordingExtension('audio/webm')).toBe('webm');
    expect(recordingName('audio/webm', new Date(2026, 9, 14, 9, 5))).toBe('הקלטה 2026-10-14 09-05.webm');
  });
});

describe('microphone problems', () => {
  it('refused (now or before) → how to allow it; no device / busy → their own words', async () => {
    const { micProblem } = await import('./VoiceRecorder');
    expect(micProblem({ name: 'NotAllowedError' })).toBe('voice.micDeniedHow');
    expect(micProblem({ name: 'SecurityError' })).toBe('voice.micDeniedHow');
    expect(micProblem({ name: 'NotFoundError' })).toBe('voice.micMissing');
    expect(micProblem({ name: 'NotReadableError' })).toBe('voice.micBusy');
    expect(micProblem(null)).toBe('voice.micDeniedHow');
  });
});
