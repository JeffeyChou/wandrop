import crypto from 'node:crypto';

const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'cosmic', 'crisp', 'dusky', 'echo', 'fuzzy', 'gentle', 'glassy',
  'hazy', 'icy', 'jolly', 'lucid', 'lunar', 'misty', 'neon', 'nimble', 'opal', 'pixel',
  'quiet', 'rapid', 'rusty', 'silent', 'solar', 'sonic', 'swift', 'tidal', 'vivid', 'witty',
];
const ANIMALS = [
  'otter', 'lynx', 'heron', 'koala', 'panda', 'raven', 'gecko', 'bison', 'crane', 'dingo',
  'ferret', 'finch', 'hare', 'ibis', 'jackal', 'lemur', 'marten', 'newt', 'orca', 'puffin',
  'quokka', 'robin', 'seal', 'tapir', 'urchin', 'vole', 'walrus', 'yak', 'zebra', 'moth',
];

const pick = (arr) => arr[crypto.randomInt(arr.length)];

export function randomName() {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${String(crypto.randomInt(100)).padStart(2, '0')}`;
}

export const ANON_NAME_RE = /^[a-z]+-[a-z]+-\d{2}$/;
