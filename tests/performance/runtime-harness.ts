import { AudioContextService, type AudioContextLike } from '../../src/engines/audio/context.js';
import { loadSoundPackManifest, type AssetFetcher } from '../../src/engines/audio/soundBank.js';

const RUNS = 10_000;

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
  };
}

async function run(): Promise<void> {
  const result = document.querySelector('#result')!;
  try {
    const fetcher: AssetFetcher = async (assetPath) => fetch(`/${assetPath}`);
    const Constructor = window.AudioContext;
    if (!Constructor) throw new Error('AudioContext unavailable');
    const audio = new AudioContextService(
      () => new Constructor({ latencyHint: 'interactive' }) as unknown as AudioContextLike,
      fetcher,
    );
    if (!await audio.unlockFromGesture()) throw new Error('AudioContext unlock failed');
    const manifest = await loadSoundPackManifest(fetcher);
    if (!await audio.prepare(manifest.packs[0])) throw new Error('Sound pack preparation failed');
    const samples: number[] = [];
    const startedAt = performance.now();
    for (let index = 0; index < RUNS; index += 1) {
      const before = performance.now();
      audio.trigger('letter', before);
      samples.push(performance.now() - before);
    }
    const elapsedMs = performance.now() - startedAt;
    const diagnostics = audio.diagnostics();
    await audio.close();
    const payload = {
      status: 'complete',
      runtime: navigator.userAgent.includes('Electron') ? 'electron' : 'browser',
      userAgent: navigator.userAgent,
      elapsedMs,
      scheduling: summarize(samples),
      baseLatencySeconds: diagnostics.baseLatency,
      outputLatencySeconds: diagnostics.outputLatency,
      note: 'API scheduling only; no physical audible-onset measurement',
    };
    result.textContent = JSON.stringify(payload);
    document.title = 'complete';
  } catch (error) {
    result.textContent = JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
    document.title = 'failed';
  }
}

await run();
