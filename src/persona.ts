import fs from 'node:fs';
import path from 'node:path';

export type Persona = {
  model: string;
  voice: string;
  silenceMs: number;
  silenceTimeoutSec: number;
  maxDurationSec: number;
  maxTurns: number;
  greeting: string;
  systemPrompt: string;
  contextBias: string[];
};

const DEFAULT_PATH = path.resolve('persona.json');
const OVERRIDE_PATH = path.resolve('persona.override.json');

function load(): Persona {
  const filePath = process.env.PERSONA_CONFIG ?? DEFAULT_PATH;
  if (!fs.existsSync(filePath)) throw new Error(`Persona config not found: ${filePath}`);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`[persona] failed to read config: ${String(err)}`);
    throw err;
  }
  const base = JSON.parse(raw) as Partial<Persona>;

  let override: Partial<Persona> = {};
  if (fs.existsSync(OVERRIDE_PATH)) {
    try {
      override = JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf-8')) as Partial<Persona>;
    } catch (err) {
      console.error(`[persona] failed to load override: ${String(err)}`);
      throw err;
    }
  }

  const merged = { ...base, ...override };

  if (!merged.model) throw new Error('persona: missing "model"');
  if (!merged.voice) throw new Error('persona: missing "voice"');
  if (!merged.systemPrompt) throw new Error('persona: missing "systemPrompt"');

  return {
    model: merged.model,
    voice: merged.voice,
    silenceMs: merged.silenceMs ?? 1500,
    silenceTimeoutSec: merged.silenceTimeoutSec ?? 10,
    maxDurationSec: merged.maxDurationSec ?? 180,
    maxTurns: merged.maxTurns ?? 15,
    greeting: merged.greeting ?? '',
    systemPrompt: merged.systemPrompt,
    contextBias: merged.contextBias ?? [],
  };
}

export const persona = load();
