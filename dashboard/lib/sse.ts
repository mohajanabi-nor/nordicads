/**
 * Client-side reader for the dashboard's SSE routes.
 *
 * `EventSource` cannot send a POST body, so every streaming route here is a POST
 * whose frames are parsed by hand. That parser was copy-pasted in GeneratePanel
 * and the picker; the campaign view would have been a third copy, so it lives
 * here instead.
 *
 * Frames are `event: <name>\ndata: <json>\n\n`, separated by a blank line.
 */
import type { RunEvent } from "./types";

export type SseHandler = (event: string, payload: RunEvent) => void;

/** Parse one `event:`/`data:` block and hand it to the caller. */
function handleBlock(block: string, onEvent: SseHandler): void {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  let payload: RunEvent;
  try {
    payload = JSON.parse(data);
  } catch {
    return; // a truncated frame — skip it rather than killing the stream
  }
  onEvent(event, payload);
}

/**
 * Consume an SSE response to completion, calling `onEvent` per frame.
 * Throws if the response carries no body.
 */
export async function readSseStream(res: Response, onEvent: SseHandler): Promise<void> {
  if (!res.body) throw new Error("Ingen strøm fra server");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      handleBlock(buf.slice(0, sep), onEvent);
      buf = buf.slice(sep + 2);
    }
  }
  if (buf.trim()) handleBlock(buf, onEvent); // flush a final unterminated frame
}
