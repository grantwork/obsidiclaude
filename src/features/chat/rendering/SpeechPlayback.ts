/**
 * Reads assistant messages aloud.
 *
 * Two backends: the operating system voices exposed through the Web Speech
 * synthesis API (fully local), and OpenAI text-to-speech (network, needs a key).
 * The controller keeps at most one active playback per chat view.
 */

import { requestUrl } from 'obsidian';

import { getProviderEnvironmentVariables, getSharedEnvironmentVariables } from '@/core/providers/providerEnvironment';
import type { ClaudianSettings } from '@/core/types/settings';
import { parseEnvironmentVariables } from '@/utils/env';

type Replacement = string | ((...args: string[]) => string);

const PLAIN_TEXT_RULES: Array<[RegExp, Replacement]> = [
  [/```[\s\S]*?```/g, ' code block omitted. '],
  [/`([^`]+)`/g, '$1'],
  [/!\[[^\]]*\]\([^)]*\)/g, ''],
  [/\[([^\]]+)\]\([^)]*\)/g, '$1'],
  [/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m: string, target: string, alias?: string) => alias ?? target],
  [/^#{1,6}\s+/gm, ''],
  [/^\s*[-*+]\s+/gm, ''],
  [/^\s*\d+\.\s+/gm, ''],
  [/^\s*>\s?/gm, ''],
  [/(\*\*|__)(.*?)\1/g, '$2'],
  [/(\*|_)(.*?)\1/g, '$2'],
  [/~~(.*?)~~/g, '$1'],
  [/^\s*[-*_]{3,}\s*$/gm, ''],
  [/\|/g, ' '],
  [/\n{2,}/g, '\n'],
];

export function markdownToSpeechText(markdown: string): string {
  let text = markdown;
  for (const [pattern, replacement] of PLAIN_TEXT_RULES) {
    text = typeof replacement === 'string'
      ? text.replace(pattern, replacement)
      : text.replace(pattern, replacement);
  }
  return text.trim();
}

export const OPENAI_TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'] as const;
export const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_OPENAI_TTS_VOICE = 'fable';
const OPENAI_TTS_MAX_INPUT_CHARS = 4000;
const OPENAI_TTS_ENDPOINT = 'https://api.openai.com/v1/audio/speech';

/** Splits long text into chunks at sentence boundaries so each request stays under the API limit. */
export function chunkSpeechText(text: string, maxChars = OPENAI_TTS_MAX_INPUT_CHARS): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
    if (sentence.length > maxChars) {
      for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars).trim());
      continue;
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
}

/** Resolves the OpenAI key from the explicit setting, then shared env, then the Codex provider env. */
export function resolveOpenAiSpeechApiKey(settings: ClaudianSettings): string {
  const explicit = settings.readAloudOpenAiApiKey?.trim();
  if (explicit) return explicit;
  const record = settings as unknown as Record<string, unknown>;
  const shared = parseEnvironmentVariables(getSharedEnvironmentVariables(record)).OPENAI_API_KEY;
  if (shared) return shared;
  return parseEnvironmentVariables(getProviderEnvironmentVariables(record, 'codex')).OPENAI_API_KEY ?? '';
}

export interface SpeechHandlers {
  onEnd: () => void;
  onError: (error: Error) => void;
}

export interface SpeechBackend {
  speak(text: string, handlers: SpeechHandlers): void;
  stop(): void;
}

class SystemSpeechBackend implements SpeechBackend {
  speak(text: string, handlers: SpeechHandlers): void {
    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.addEventListener('end', () => handlers.onEnd());
    utterance.addEventListener('error', (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      handlers.onError(new Error(`Speech synthesis failed: ${event.error}`));
    });
    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    window.speechSynthesis.cancel();
  }
}

interface OpenAiSpeechConfig {
  apiKey: string;
  model: string;
  voice: string;
}

function readErrorDetail(response: { json?: unknown }): string {
  try {
    const parsed = response.json as { error?: { message?: string } } | undefined;
    return parsed?.error?.message ?? '';
  } catch {
    return '';
  }
}

class OpenAiSpeechBackend implements SpeechBackend {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private cancelled = false;

  constructor(private readonly config: OpenAiSpeechConfig) {}

  speak(text: string, handlers: SpeechHandlers): void {
    this.cancelled = false;
    void this.run(text, handlers);
  }

  stop(): void {
    this.cancelled = true;
    this.releaseAudio();
  }

  private async run(text: string, handlers: SpeechHandlers): Promise<void> {
    try {
      const chunks = chunkSpeechText(text);
      // Fetch the next chunk while the current one plays.
      let pending = this.fetchChunk(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const buffer = await pending;
        if (this.cancelled) return;
        pending = i + 1 < chunks.length ? this.fetchChunk(chunks[i + 1]) : Promise.resolve(new ArrayBuffer(0));
        await this.play(buffer);
        if (this.cancelled) return;
      }
      handlers.onEnd();
    } catch (error) {
      if (this.cancelled) return;
      this.releaseAudio();
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async fetchChunk(input: string): Promise<ArrayBuffer> {
    const response = await requestUrl({
      url: OPENAI_TTS_ENDPOINT,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.config.model, voice: this.config.voice, input, response_format: 'mp3' }),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = readErrorDetail(response);
      throw new Error(`OpenAI text-to-speech failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return response.arrayBuffer;
  }

  private play(buffer: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.releaseAudio();
      this.objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/mpeg' }));
      const audio = new Audio(this.objectUrl);
      this.audio = audio;
      audio.addEventListener('ended', () => resolve());
      audio.addEventListener('error', () => reject(new Error('Audio playback failed')));
      audio.play().catch(reject);
    });
  }

  private releaseAudio(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

/** Picks the backend for the current settings, or null when none can work. */
export function createSpeechBackend(settings: ClaudianSettings | undefined): SpeechBackend | null {
  if (settings?.readAloudProvider === 'openai') {
    const apiKey = resolveOpenAiSpeechApiKey(settings);
    if (apiKey) {
      return new OpenAiSpeechBackend({
        apiKey,
        model: settings.readAloudOpenAiModel?.trim() || DEFAULT_OPENAI_TTS_MODEL,
        voice: settings.readAloudOpenAiVoice?.trim() || DEFAULT_OPENAI_TTS_VOICE,
      });
    }
  }
  return isSpeechSynthesisSupported() ? new SystemSpeechBackend() : null;
}

export function isReadAloudAvailable(settings: ClaudianSettings | undefined): boolean {
  return createSpeechBackend(settings) !== null;
}

export interface SpeechPlaybackCallbacks {
  onStart: () => void;
  onStop: () => void;
  onError?: (error: Error) => void;
}

/**
 * Owns at most one active playback per chat view so starting playback on one
 * message stops any other.
 */
export class SpeechPlaybackController {
  private activeButton: HTMLElement | null = null;
  private activeBackend: SpeechBackend | null = null;
  private onStop: (() => void) | null = null;

  constructor(private readonly backendFactory: () => SpeechBackend | null) {}

  get isSpeaking(): boolean {
    return this.activeButton !== null;
  }

  isActive(button: HTMLElement): boolean {
    return this.activeButton === button;
  }

  toggle(button: HTMLElement, markdown: string, callbacks: SpeechPlaybackCallbacks): void {
    if (this.isActive(button)) {
      this.stop();
      return;
    }
    this.stop();

    const text = markdownToSpeechText(markdown);
    if (!text) return;
    const backend = this.backendFactory();
    if (!backend) return;

    const finish = () => {
      if (this.activeButton !== button) return;
      this.activeButton = null;
      this.activeBackend = null;
      this.onStop = null;
      callbacks.onStop();
    };

    this.activeButton = button;
    this.activeBackend = backend;
    this.onStop = callbacks.onStop;
    callbacks.onStart();
    backend.speak(text, {
      onEnd: finish,
      onError: (error) => {
        finish();
        callbacks.onError?.(error);
      },
    });
  }

  stop(): void {
    if (!this.activeButton) return;
    const onStop = this.onStop;
    const backend = this.activeBackend;
    this.activeButton = null;
    this.activeBackend = null;
    this.onStop = null;
    backend?.stop();
    onStop?.();
  }
}
