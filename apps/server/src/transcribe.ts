/* Voice dictation proxy (issue #15) — forwards one recorded take to the
   speech endpoint the operator configured, OpenAI-compatible shape:
   multipart POST with `file` + `model`, expecting { text } back.

   Config (env, read per request so tests and late config both work):
     TRUSS_TRANSCRIBE_URL        /audio/transcriptions-style endpoint URL
     TRUSS_TRANSCRIBE_MODEL      model field (default "whisper-1")
     TRUSS_TRANSCRIBE_API_KEY    bearer token, optional
     TRUSS_TRANSCRIBE_TIMEOUT_MS upstream deadline in ms (default 120000) */

export interface TranscribeConfig {
  url?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export function transcribeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TranscribeConfig {
  const timeoutMs = Number(env.TRUSS_TRANSCRIBE_TIMEOUT_MS);
  return {
    ...(env.TRUSS_TRANSCRIBE_URL ? { url: env.TRUSS_TRANSCRIBE_URL } : {}),
    ...(env.TRUSS_TRANSCRIBE_MODEL ? { model: env.TRUSS_TRANSCRIBE_MODEL } : {}),
    ...(env.TRUSS_TRANSCRIBE_API_KEY ? { apiKey: env.TRUSS_TRANSCRIBE_API_KEY } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}

/* file extension the endpoint expects to match the payload's mime */
function extForMime(mime: string | undefined): string {
  const base = (mime ?? "").split(";")[0]?.trim();
  switch (base) {
    case "audio/ogg": return "ogg";
    case "audio/mp4":
    case "audio/x-m4a": return "m4a";
    case "audio/mpeg": return "mp3";
    case "audio/wav":
    case "audio/x-wav": return "wav";
    case "audio/flac": return "flac";
    default: return "webm";
  }
}

export async function transcribeAudio(
  audio: Buffer,
  mime: string | undefined,
  cfg: TranscribeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!cfg.url) throw new Error("transcription endpoint is not configured");
  if (!audio.length) return "";
  const type = mime ?? "audio/webm";
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(audio)], { type }), `take.${extForMime(mime)}`);
  form.set("model", cfg.model ?? "whisper-1");
  let res: Response;
  try {
    /* bounded: a stalled endpoint must surface as a 502, not park the
       request until the fetch defaults give up */
    res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 120_000),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new Error("transcription endpoint timed out");
    throw e;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`transcription endpoint answered ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
  if (!data || typeof data.text !== "string") throw new Error("transcription endpoint returned no text");
  return data.text;
}
