import { describe, expect, it } from 'vitest';
import { createBackupEnvelope, validateAndParseBackup } from '../../src/contracts/backup.js';
const base = { formatVersion: 1, schemaVersion: 1, exportedAt: '2026-09-21T00:00:00.000Z', appBuild: 'test', profiles: [], payloads: { sessions: [], sessionSeries: [], daySlices: [], mistakes: [], exposures: [], lessonProgress: [], dailyAggregates: [], documents: [] }, contentVersions: {} };
describe('backup validation', () => {
  it('creates and verifies a checksummed envelope', async () => { const envelope = await createBackupEnvelope(base); expect((await validateAndParseBackup(JSON.stringify(envelope))).checksum).toBe(envelope.checksum); });
  it('rejects tampering and malformed input', async () => { const envelope = await createBackupEnvelope(base); const tampered = { ...envelope, appBuild: 'changed' }; await expect(validateAndParseBackup(JSON.stringify(tampered))).rejects.toThrow(/checksum/i); await expect(validateAndParseBackup('{')).rejects.toThrow(); });
});
