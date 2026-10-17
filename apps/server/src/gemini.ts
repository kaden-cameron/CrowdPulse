// Minimal Gemini REST client (models.generateContent with JSON-schema output).
// The API key stays server-side and is sent only in the x-goog-api-key header.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export interface ModelCall {
  text: string;
  responseId: string | null;
  modelVersion: string | null;
  latencyMs: number;
  usage: { promptTokens?: number; outputTokens?: number; totalTokens?: number } | null;
}

export class ModelError extends Error {
  readonly code: "timeout" | "http" | "blocked" | "empty" | "network";
  readonly status?: number;
  readonly latencyMs: number;

  constructor(code: ModelError["code"], message: string, latencyMs: number, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.latencyMs = latencyMs;
  }
}

/** Anything that can turn a prompt + schema into JSON text. Tests substitute a fake. */
export interface RecommendationModel {
  readonly model: string;
  generate(input: { system: string; user: string; schema: object }): Promise<ModelCall>;
}

export class GeminiClient implements RecommendationModel {
  readonly model: string;
  private apiKey: string;
  private timeoutMs: number;
  private maxOutputTokens: number;

  constructor(apiKey: string, model = DEFAULT_GEMINI_MODEL, timeoutMs = 8_000, maxOutputTokens = 400) {
    this.maxOutputTokens = maxOutputTokens;
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async generate({ system, user, schema }: { system: string; user: string; schema: object }): Promise<ModelCall> {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    let res: Response;
    try {
      res = await fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
            temperature: 0.4,
            maxOutputTokens: this.maxOutputTokens,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new ModelError("timeout", `Gemini timed out after ${this.timeoutMs} ms`, elapsed());
      }
      throw new ModelError("network", `Gemini request failed: ${e.message}`, elapsed());
    }

    const body = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      // Error messages from Google never include the key, but keep them short anyway.
      const msg = body.error?.message?.slice(0, 200) ?? res.statusText;
      throw new ModelError("http", `Gemini HTTP ${res.status}: ${msg}`, elapsed(), res.status);
    }
    if (body.promptFeedback?.blockReason) {
      throw new ModelError("blocked", `Gemini blocked the prompt (${body.promptFeedback.blockReason})`, elapsed());
    }
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) {
      const reason = body.candidates?.[0]?.finishReason ?? "no candidates";
      throw new ModelError("empty", `Gemini returned no text (${reason})`, elapsed());
    }
    return {
      text,
      responseId: body.responseId ?? null,
      modelVersion: body.modelVersion ?? null,
      latencyMs: elapsed(),
      usage: body.usageMetadata
        ? {
            promptTokens: body.usageMetadata.promptTokenCount,
            outputTokens: body.usageMetadata.candidatesTokenCount,
            totalTokens: body.usageMetadata.totalTokenCount,
          }
        : null,
    };
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  responseId?: string;
  modelVersion?: string;
  error?: { message?: string };
}
