/**
 * Voice processing module for NanoClaw
 * STT: OpenAI Whisper API (transcription)
 * TTS: msedge-tts (synthesis)
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  VOICE_LANGUAGE,
  VOICE_TTS_VOICE,
  VOICE_MAX_DURATION_SEC,
} from './config.js';

const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_TIMEOUT_MS = 30_000;

function getOpenAIKey(): string | null {
  const key =
    process.env.OPENAI_API_KEY ||
    readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  return key || null;
}

/**
 * Transcribe a voice message buffer using OpenAI Whisper API.
 * Returns the transcribed text, or throws on failure.
 */
export async function transcribeVoice(
  buffer: Buffer,
  language?: string,
): Promise<string> {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set — cannot transcribe voice');
  }

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([buffer], { type: 'audio/ogg' }),
    'voice.ogg',
  );
  formData.append('model', 'whisper-1');
  formData.append('language', language || VOICE_LANGUAGE);

  const response = await fetch(WHISPER_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
    signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Whisper API ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { text: string };
  return data.text.trim();
}

/**
 * Synthesize text to audio buffer using msedge-tts.
 * Returns an audio buffer (mp3).
 */
export async function synthesizeVoice(
  text: string,
  voice?: string,
): Promise<Buffer> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(
    voice || VOICE_TTS_VOICE,
    OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
  );

  const { audioStream } = tts.toStream(text);
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    audioStream.on('end', () => resolve(Buffer.concat(chunks)));
    audioStream.on('error', reject);
  });
}

/**
 * Check if voice duration is within the allowed limit.
 */
export function isVoiceDurationAllowed(durationSec: number): boolean {
  return durationSec <= VOICE_MAX_DURATION_SEC;
}

/**
 * Log a warning at startup if OPENAI_API_KEY is missing.
 */
export function checkVoiceConfig(): void {
  if (!getOpenAIKey()) {
    logger.warn(
      'OPENAI_API_KEY not set — voice messages will not be transcribed',
    );
  }
}
