/**
 * Reads assistant messages aloud using the operating system voices exposed
 * through the Web Speech synthesis API. No audio or text leaves the machine.
 */

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
    text = typeof replacement === "string"
      ? text.replace(pattern, replacement)
      : text.replace(pattern, replacement);
  }
  return text.trim();
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
}

/**
 * Owns at most one active utterance per chat view so starting playback on one
 * message stops any other.
 */
export class SpeechPlaybackController {
  private activeButton: HTMLElement | null = null;
  private onStop: (() => void) | null = null;

  get isSpeaking(): boolean {
    return this.activeButton !== null;
  }

  isActive(button: HTMLElement): boolean {
    return this.activeButton === button;
  }

  toggle(button: HTMLElement, markdown: string, callbacks: { onStart: () => void; onStop: () => void }): void {
    if (this.isActive(button)) {
      this.stop();
      return;
    }
    this.stop();
    if (!isSpeechSynthesisSupported()) return;

    const text = markdownToSpeechText(markdown);
    if (!text) return;

    const utterance = new window.SpeechSynthesisUtterance(text);
    const finish = () => {
      if (this.activeButton !== button) return;
      this.activeButton = null;
      this.onStop = null;
      callbacks.onStop();
    };
    utterance.addEventListener('end', finish);
    utterance.addEventListener('error', finish);

    this.activeButton = button;
    this.onStop = callbacks.onStop;
    callbacks.onStart();
    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    if (!this.activeButton) return;
    const onStop = this.onStop;
    this.activeButton = null;
    this.onStop = null;
    if (isSpeechSynthesisSupported()) window.speechSynthesis.cancel();
    onStop?.();
  }
}
