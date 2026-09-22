/** Renderer-side Repository adapter. No Node or Electron APIs cross this boundary. */

import type {
  ActiveCheckpoint, BackupEnvelope, DocumentId, InstallationSettings, Profile, ProfileId, ProfileSettings, SessionId,
} from '../../contracts/models.js';
import {
  err,
  type DocumentWrite,
  type ImportOptions,
  type Repository,
  type RepositoryError,
  type RepositoryResult,
  type SessionCommit,
  type SessionQuery,
} from '../../contracts/repository.js';
import { IPC_PROTOCOL_VERSION, type FfBridge, type FfIpcChannel } from '../../contracts/platform.js';

const ERROR_CODES = new Set<RepositoryError['code']>([
  'quota', 'permission', 'corrupt', 'conflict', 'unavailable', 'version-too-new', 'not-found', 'invalid',
  'storage-denied', 'unsupported',
]);

function invalidResponse(message: string): RepositoryResult<never> {
  return err({ code: 'corrupt', message, retryable: false });
}

export class DesktopRepositoryAdapter implements Repository {
  constructor(private readonly bridge: FfBridge) {}

  private async invoke<T>(channel: FfIpcChannel, args: unknown[]): Promise<RepositoryResult<T>> {
    try {
      const response = await this.bridge.invoke({ channel, payload: args });
      if (!response || response.protocol !== IPC_PROTOCOL_VERSION || typeof response.requestId !== 'string') {
        return invalidResponse('Desktop bridge returned an invalid response');
      }
      if (response.ok) return { ok: true, value: response.value as T };
      if (!response.error || !ERROR_CODES.has(response.error.code) || typeof response.error.message !== 'string'
        || typeof response.error.retryable !== 'boolean') return invalidResponse('Desktop bridge returned an invalid error');
      return { ok: false, error: response.error };
    } catch (error) {
      return err({ code: 'unavailable', message: 'Desktop repository IPC failed', retryable: true,
        detail: error instanceof Error ? error.message : String(error) });
    }
  }

  initialize = () => this.invoke<void>('repo.initialize', []);
  schemaVersion = () => this.invoke<number>('repo.schemaVersion', []);
  storageStatus = () => this.invoke<Awaited<ReturnType<Repository['storageStatus']>> extends RepositoryResult<infer T> ? T : never>('repo.storageStatus', []);
  listProfiles = () => this.invoke<Awaited<ReturnType<Repository['listProfiles']>> extends RepositoryResult<infer T> ? T : never>('repo.listProfiles', []);
  createProfile = (input: Parameters<Repository['createProfile']>[0]) => this.invoke<Profile>('repo.createProfile', [input]);
  updateProfile = (profile: Profile) => this.invoke<Profile>('repo.updateProfile', [profile]);
  deleteProfile = (profileId: ProfileId) => this.invoke<void>('repo.deleteProfile', [profileId]);
  loadProfileSettings = (profileId: ProfileId) => this.invoke<ProfileSettings>('repo.loadProfileSettings', [profileId]);
  saveProfileSettings = (profileId: ProfileId, settings: ProfileSettings) => this.invoke<void>('repo.saveProfileSettings', [profileId, settings]);
  loadInstallationSettings = () => this.invoke<InstallationSettings>('repo.loadInstallationSettings', []);
  saveInstallationSettings = (settings: InstallationSettings) => this.invoke<void>('repo.saveInstallationSettings', [settings]);
  querySessions = (query: SessionQuery) => this.invoke<Awaited<ReturnType<Repository['querySessions']>> extends RepositoryResult<infer T> ? T : never>('repo.querySessions', [query]);
  getSession = (sessionId: SessionId) => this.invoke<Awaited<ReturnType<Repository['getSession']>> extends RepositoryResult<infer T> ? T : never>('repo.getSession', [sessionId]);
  commitSession = (commit: SessionCommit) => this.invoke<Awaited<ReturnType<Repository['commitSession']>> extends RepositoryResult<infer T> ? T : never>('repo.commitSession', [commit]);
  getSessionSeries = (sessionId: SessionId) => this.invoke<Awaited<ReturnType<Repository['getSessionSeries']>> extends RepositoryResult<infer T> ? T : never>('repo.getSessionSeries', [sessionId]);
  getLessonProgress = (profileId: ProfileId, curriculumVersion: string) => this.invoke<Awaited<ReturnType<Repository['getLessonProgress']>> extends RepositoryResult<infer T> ? T : never>('repo.getLessonProgress', [profileId, curriculumVersion]);
  getDailyAggregates = (profileId: ProfileId, from: string, to: string) => this.invoke<Awaited<ReturnType<Repository['getDailyAggregates']>> extends RepositoryResult<infer T> ? T : never>('repo.getDailyAggregates', [profileId, from, to]);
  rebuildAggregates = (profileId: ProfileId) => this.invoke<void>('repo.rebuildAggregates', [profileId]);
  getCharacterStats = (profileId: ProfileId) => this.invoke<Awaited<ReturnType<Repository['getCharacterStats']>> extends RepositoryResult<infer T> ? T : never>('repo.getCharacterStats', [profileId]);
  rebuildCharacterStats = (profileId: ProfileId) => this.invoke<void>('repo.rebuildCharacterStats', [profileId]);
  resetCharacterStats = (profileId: ProfileId) => this.invoke<void>('repo.resetCharacterStats', [profileId]);
  saveCheckpoint = (checkpoint: ActiveCheckpoint) => this.invoke<void>('repo.saveCheckpoint', [checkpoint]);
  getCheckpoint = (sessionId: SessionId) => this.invoke<ActiveCheckpoint | null>('repo.getCheckpoint', [sessionId]);
  findLatestCheckpoint = (profileId: ProfileId) => this.invoke<ActiveCheckpoint | null>('repo.findLatestCheckpoint', [profileId]);
  deleteCheckpoint = (sessionId: SessionId) => this.invoke<void>('repo.deleteCheckpoint', [sessionId]);
  saveDocument = (write: DocumentWrite) => this.invoke<Awaited<ReturnType<Repository['saveDocument']>> extends RepositoryResult<infer T> ? T : never>('repo.saveDocument', [write]);
  getDocument = (documentId: DocumentId) => this.invoke<Awaited<ReturnType<Repository['getDocument']>> extends RepositoryResult<infer T> ? T : never>('repo.getDocument', [documentId]);
  listDocuments = (profileId: ProfileId) => this.invoke<Awaited<ReturnType<Repository['listDocuments']>> extends RepositoryResult<infer T> ? T : never>('repo.listDocuments', [profileId]);
  getDocumentChunks = (documentId: DocumentId, fromChunkIndex: number, maxChunks: number) => this.invoke<Awaited<ReturnType<Repository['getDocumentChunks']>> extends RepositoryResult<infer T> ? T : never>('repo.getDocumentChunks', [documentId, fromChunkIndex, maxChunks]);
  deleteDocument = (documentId: DocumentId) => this.invoke<void>('repo.deleteDocument', [documentId]);
  exportBackup = (options: Parameters<Repository['exportBackup']>[0]) => this.invoke<BackupEnvelope>('repo.exportBackup', [options]);
  importBackup = (envelope: BackupEnvelope, options: ImportOptions) => this.invoke<Awaited<ReturnType<Repository['importBackup']>> extends RepositoryResult<infer T> ? T : never>('repo.importBackup', [envelope, options]);
}
