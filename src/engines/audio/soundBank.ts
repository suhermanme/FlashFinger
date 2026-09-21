export const SOUND_CATEGORIES = ['letter', 'space', 'enter', 'backspace', 'error'] as const;
export type SoundCategory = (typeof SOUND_CATEGORIES)[number];

export interface SoundSampleDefinition { path: string; sha256: string; durationMs: number; gain: number }
export interface SoundPackDefinition {
  id: string;
  version: string;
  name: string;
  license: string;
  attribution: string;
  format: 'pcm-json';
  samples: Record<SoundCategory, SoundSampleDefinition[]>;
}
export interface SoundPackManifest { manifestVersion: number; packs: SoundPackDefinition[] }

export interface AudioBufferLike { readonly length: number; readonly sampleRate: number; readonly numberOfChannels: number }
export interface BufferFactory { createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike & { copyToChannel(source: Float32Array, channelNumber: number): void } }
export interface LoadedSample { buffer: AudioBufferLike; gain: number; durationMs: number }
export interface LoadedSoundPack { definition: SoundPackDefinition; categories: Record<SoundCategory, LoadedSample[]>; decodedBytes: number }
export type AssetFetcher = (path: string) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;

export const MAX_DECODED_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_CACHED_SOUND_PACKS = 2;

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function loadSoundPackManifest(fetcher: AssetFetcher, path = 'content/sound-packs.json'): Promise<SoundPackManifest> {
  const bytes = await (await fetcher(path)).arrayBuffer();
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SoundPackManifest>;
  if (parsed.manifestVersion !== 1 || !Array.isArray(parsed.packs)) throw new Error('Sound-pack manifest is invalid');
  return parsed as SoundPackManifest;
}

export class SoundBank {
  private readonly cache = new Map<string, LoadedSoundPack>();
  private totalBytes = 0;
  constructor(private readonly fetcher: AssetFetcher, private readonly verifyHashes = true) {}

  async load(definition: SoundPackDefinition, factory: BufferFactory): Promise<LoadedSoundPack> {
    const key = `${definition.id}@${definition.version}`;
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const assets = new Map<string, AudioBufferLike>();
    let decodedBytes = 0;
    for (const sample of Object.values(definition.samples).flat()) {
      if (assets.has(sample.path)) continue;
      const bytes = await (await this.fetcher(sample.path)).arrayBuffer();
      if (this.verifyHashes && await sha256(bytes) !== sample.sha256) throw new Error(`Sound asset checksum mismatch: ${sample.path}`);
      const data = JSON.parse(new TextDecoder().decode(bytes)) as { sampleRate?: unknown; samples?: unknown };
      if (!Number.isFinite(data.sampleRate) || !Array.isArray(data.samples) || data.samples.length === 0) throw new Error(`Invalid PCM asset: ${sample.path}`);
      const values = Float32Array.from(data.samples as number[]);
      if ([...values].some((value) => !Number.isFinite(value) || Math.abs(value) > 1)) throw new Error(`PCM sample out of range: ${sample.path}`);
      const buffer = factory.createBuffer(1, values.length, data.sampleRate as number);
      buffer.copyToChannel(values, 0);
      assets.set(sample.path, buffer);
      decodedBytes += values.byteLength;
    }
    if (decodedBytes > MAX_DECODED_AUDIO_BYTES) throw new Error('Decoded sound pack exceeds the 16 MiB cap');
    const categories = Object.fromEntries(SOUND_CATEGORIES.map((category) => [category,
      definition.samples[category].map((sample) => ({ buffer: assets.get(sample.path)!, gain: sample.gain, durationMs: sample.durationMs })),
    ])) as Record<SoundCategory, LoadedSample[]>;
    const loaded = { definition, categories, decodedBytes };
    while (this.cache.size >= MAX_CACHED_SOUND_PACKS || this.totalBytes + decodedBytes > MAX_DECODED_AUDIO_BYTES) {
      const oldest = this.cache.entries().next().value as [string, LoadedSoundPack] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.totalBytes -= oldest[1].decodedBytes;
    }
    this.cache.set(key, loaded);
    this.totalBytes += decodedBytes;
    return loaded;
  }
  clear(): void { this.cache.clear(); this.totalBytes = 0; }
  get cachedPackCount(): number { return this.cache.size; }
  get decodedBytes(): number { return this.totalBytes; }
}
