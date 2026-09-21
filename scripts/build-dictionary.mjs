import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourcePath = process.argv[2] ?? '/usr/share/dict/american-english';
const outputPath = resolve('public/content/dictionaries/ff-english-10k-v1.json');
const source = await readFile(sourcePath, 'utf8');
const excluded = new Set([
  'arse', 'asses', 'bastard', 'bitch', 'bitches', 'bloody', 'bollocks', 'bullshit', 'crap', 'damn',
  'dick', 'dicks', 'fuck', 'fucked', 'fucker', 'fucking', 'hell', 'nazi', 'penis', 'porn', 'porno',
  'sex', 'shit', 'slut', 'sluts', 'vagina', 'whore', 'whores',
]);
const common = new Set(`the of and to in is you that it he was for on are as with his they I at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part over new sound take only little work know place year live me back give most very after thing our just name good sentence man think say great where help through much before line right too mean old any same tell boy follow came want show also around form three small set put end does another well large must big even such because turn here why ask went men read need land different home us move try kind hand picture again change off play spell air away animal house point page letter mother answer found study still learn should america world high every near add food between own below country plant last school father keep tree never start city earth eyes light thought head under story saw left dont few while along might close something seem next hard open example begin life always those both paper together got group often run important until children side feet car mile night walk white sea began grow took river four carry state once book hear stop without second later miss idea enough eat face watch far indian real almost let above girl sometimes mountain cut young talk soon list song being leave family`.toLowerCase().split(/\s+/));
const candidates = [...new Set(source.split(/\r?\n/))]
  .filter((word) => /^[a-z]{2,14}$/.test(word) && !excluded.has(word));

function hash(word) {
  return createHash('sha256').update(word).digest().readUInt32BE(0);
}

function rank(word) {
  return (common.has(word) ? -1_000_000_000 : 0) + word.length * 10_000_000 + hash(word);
}

const used = new Set();
function take(count, minimum, maximum) {
  const selected = candidates.filter((word) => !used.has(word) && word.length >= minimum && word.length <= maximum)
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right)).slice(0, count);
  if (selected.length !== count) throw new Error(`Only ${selected.length}/${count} words available for ${minimum}-${maximum}`);
  selected.forEach((word) => used.add(word));
  return selected;
}

const pools = {
  beginner: take(1_000, 2, 5),
  intermediate: take(4_000, 4, 8),
  advanced: take(5_000, 6, 14),
};
let index = 0;
const entries = Object.entries(pools).flatMap(([difficulty, words]) => words.map((spelling) => ({
  id: `ff-en-${String(++index).padStart(5, '0')}`,
  spelling,
  graphemeLength: spelling.length,
  difficulty,
  frequencyBand: difficulty === 'beginner' ? 'high' : difficulty === 'intermediate' ? 'general' : 'extended',
  punctuationSuitable: true,
  capitalizationSuitable: true,
})));
const manifest = {
  id: 'ff-english-10k-v1',
  version: 'ff-english-10k-v1',
  language: 'en-US',
  source: 'SCOWL-derived Debian wamerican word list',
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  selectionPolicy: 'lowercase ASCII, proper-name exclusion by source casing, explicit safety exclusions, deterministic length/commonness/hash ranking',
  counts: { beginner: 1_000, intermediate: 4_000, advanced: 5_000, total: 10_000 },
  entries,
};
await mkdir(resolve('public/content/dictionaries'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest)}\n`, 'utf8');
