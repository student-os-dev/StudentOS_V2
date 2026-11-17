import { OllamaError } from './ollama.ts';
export class InferenceGate {
  private busy = false;
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new OllamaError('BUSY', 'Another inference operation is running. Try again shortly.', 503);
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
}
