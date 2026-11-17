export class KnowledgeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
export function invalid(): never { throw new KnowledgeError(400, 'INVALID_REQUEST', 'Invalid knowledge request.'); }
function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) invalid();
}
function plainText(value: unknown, maxChars: number, multiline: boolean): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxChars || Buffer.from(value, 'utf8').toString('utf8') !== value ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
      (!multiline && /[\r\n\t]/.test(value))) invalid();
  return value;
}
export interface TextInput { title: string; text: string; fictional: boolean }
export function textInput(value: unknown, revision = false): TextInput {
  record(value);
  exactKeys(value, ['title', 'text'], revision ? [] : ['fictional']);
  const title = plainText(value.title, 160, false);
  const text = plainText(value.text, 20000, true);
  if (Buffer.byteLength(text, 'utf8') > 65536 ||
      (!revision && value.fictional !== undefined && typeof value.fictional !== 'boolean')) invalid();
  // Preserve accepted text verbatim; never interpret it as HTML, markdown or file bytes.
  return { title, text, fictional: revision ? false : value.fictional === true };
}
export function reviewInput(value: unknown, reject: boolean): string | null {
  record(value); exactKeys(value, reject ? ['note'] : [], reject ? [] : ['note']);
  return value.note === undefined ? null : plainText(value.note, 1000, true);
}
export function emptyInput(value: unknown) { record(value); exactKeys(value, []); }
export function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) invalid();
  return value;
}
export function pagination(query: unknown): { limit: number; offset: number } {
  record(query); exactKeys(query, [], ['limit', 'offset']);
  function number(value: unknown, fallback: number, min: number, max: number) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) invalid();
    return result;
  }
  return { limit: number(query.limit, 25, 1, 100), offset: number(query.offset, 0, 0, 1000000) };
}
export function expectedTag(value: string | undefined): string {
  if (!value) throw new KnowledgeError(428, 'PRECONDITION_REQUIRED', 'Supply the current document ETag in If-Match.');
  if (!/^"[A-Za-z0-9][A-Za-z0-9:_-]{0,127}:[0-9]+"$/.test(value)) invalid();
  return value;
}
