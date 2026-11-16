import fs from 'node:fs';
import path from 'node:path';

export type FrameDirection = 'in' | 'out';

/** One line of a `--record` file. */
export interface RecordedFrame {
  /** Epoch ms when the frame was seen. */
  t: number;
  /** `in` = server → MCP, `out` = MCP → server. */
  dir: FrameDirection;
  /** Parsed JSON frame (or the raw string if it was not JSON). */
  frame: unknown;
}

/**
 * Appends every raw WebSocket frame to a JSONL file. Used to capture real
 * protocol traffic and to build fixtures for the fake-server tests.
 */
export class Recorder {
  private readonly stream: fs.WriteStream;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), {recursive: true});
    this.stream = fs.createWriteStream(filePath, {flags: 'a'});
  }

  write(dir: FrameDirection, data: unknown): void {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let frame: unknown = text;
    try {
      frame = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const line: RecordedFrame = {t: Date.now(), dir, frame};
    this.stream.write(`${JSON.stringify(line)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

export function readRecording(filePath: string): RecordedFrame[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedFrame);
}
