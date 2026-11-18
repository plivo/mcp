import type { Param } from "./catalog";
import type { CallArgs } from "./upstream";

/** The one operation that answers with audio instead of JSON. */
export const SPEAK_OP = "POST /TTS/";

/**
 * One call speaks at most this many characters: about a minute of speech, which as mp3 stays well under
 * MAX_AUDIO_BYTES. Plivo's own limit is 5,000; the rest is the CLI's to speak, where a file can hold it.
 */
export const SPEAK_MAX_CHARS = 1_000;

/** The most audio one reply may carry; base64 makes it a third larger in the tool result. */
export const MAX_AUDIO_BYTES = 750_000;

/** Every call asks for this format: mp3 at 24 kHz and 48 kbps is small, plays everywhere, and is the pair Plivo accepts at 24 kHz. */
export const SPEAK_FORMAT = { container: "mp3", encoding: "mp3", sample_rate: 24000, bitrate: 48000 } as const;

export const SPEAK_LANGUAGES = ["auto", "en-US", "en-GB", "en-IN", "en-AU", "hi", "bn", "ta", "te", "mr", "gu", "kn"];
const PACE = { min: 0.7, max: 1.2 };
const VOLUME = { min: 0.5, max: 2.0 };

/** The call with the audio format pinned; the model never chooses it. */
export function speakArgs<T extends CallArgs>(args: T): T {
  return { ...args, params: { ...args.params, output_format: SPEAK_FORMAT } };
}

const inRange = (v: unknown, r: { min: number; max: number }) => typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max;

/** Why a speak request is refused before the user is asked to approve it: it is billed per character, so nothing odd may reach Plivo. */
export function speakError(params: Record<string, unknown>): string | undefined {
  if (params.output_format !== undefined) return "output_format is not accepted through this server, which always returns mp3";
  if (typeof params.voice_id !== "string" || params.voice_id.trim() === "") return "voice_id must be a voice from list_voices";
  if (typeof params.text !== "string" || params.text.trim() === "") return "text must be the words to speak";
  const chars = [...params.text].length;
  if (chars > SPEAK_MAX_CHARS) {
    return `text has ${chars} characters; one request through this server may speak at most ${SPEAK_MAX_CHARS}. Split it into smaller requests, or use the Plivo CLI (plivo tts speak) for longer text`;
  }
  if (params.language !== undefined && !SPEAK_LANGUAGES.includes(params.language as string)) {
    return `language must be one of ${SPEAK_LANGUAGES.join(", ")}; got ${JSON.stringify(params.language)}`;
  }
  if (params.pace !== undefined && !inRange(params.pace, PACE)) return `pace must be a number from ${PACE.min} to ${PACE.max}`;
  if (params.volume !== undefined && !inRange(params.volume, VOLUME)) return `volume must be a number from ${VOLUME.min} to ${VOLUME.max}`;
  return undefined;
}

/** The params as this server takes them: no output_format, and the limit it sets on text. */
export function speakDocs(params: Param[]): Param[] {
  return params
    .filter((p) => p.name !== "output_format")
    .map((p) => (p.name === "text" ? { ...p, description: `Text to speak, up to ${SPEAK_MAX_CHARS} characters through this server.` } : p));
}

/** Plivo may bill a request it then fails to answer, so a retry could bill twice. */
export const SPEAK_BILLED_NOTE = "Plivo may have billed this request even though no audio came back. Check GET /TTS/Usage/ before sending it again.";

// 0x8000 bytes at a time: spreading a whole clip into one call would overflow the stack.
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
