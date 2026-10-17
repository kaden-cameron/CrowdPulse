// Structured JSON logs. Never pass tokens, keys, or auth headers here.
export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
