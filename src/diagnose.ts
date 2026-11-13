import * as z from "zod/v4";
import { getOperation } from "./catalog";
import { buildRequest, callUpstream, readCapped, type Credential } from "./upstream";

// The assistant does live log lookups: 30 s to 2 min for a call.
const TIMEOUT_MS = 150_000;
const MAX_STREAM_BYTES = 2_000_000;
const ESCALATE_TOOL = "escalate_to_support";

interface Subject {
  idParam: "call_uuid" | "message_uuid";
  recordOp: string;
  listTool: string;
}

const SUBJECTS = {
  call: { idParam: "call_uuid", recordOp: "GET /Call/{call_uuid}/", listTool: "list_calls" },
  message: { idParam: "message_uuid", recordOp: "GET /Message/{message_uuid}/", listTool: "list_messages" },
} satisfies Record<string, Subject>;

export type DiagnoseKind = keyof typeof SUBJECTS;

export const diagnoseTools = [
  {
    name: "diagnose_call",
    kind: "call" as const,
    title: "Diagnose a call",
    description:
      "Ask Plivo's support assistant what happened on a call: why it was answered, dropped or failed, and anything " +
      "unusual in its SIP and media traces, which the API does not expose. Takes 30 seconds to 2 minutes.",
    inputSchema: z.strictObject({ call_uuid: z.string().describe("The call's UUID, from list_calls or get_call") }),
  },
  {
    name: "diagnose_message",
    kind: "message" as const,
    title: "Diagnose a message",
    description:
      "Ask Plivo's support assistant why an SMS, MMS or WhatsApp message failed or what its status means, from the " +
      "carrier delivery report and Plivo's own records. Takes up to a minute.",
    inputSchema: z.strictObject({ message_uuid: z.string().describe("The message's UUID, from list_messages or get_message") }),
  },
];

export interface DiagnoseConfig {
  apiBase: string;
  fetchImpl?: typeof fetch;
  onTokenRejected?: () => void;
}

export interface DiagnoseResult {
  value: unknown;
  isError?: boolean;
}

export async function diagnose(kind: DiagnoseKind, uuid: string, caller: Credential | undefined, config: DiagnoseConfig): Promise<DiagnoseResult> {
  const subject: Subject = SUBJECTS[kind];
  if (!caller) return { value: "This request has no Plivo credentials.", isError: true };
  // The assistant is reached only through the auth proxy, which Basic auth bypasses.
  if (!caller.authorization.startsWith("Bearer ")) return { value: "Diagnose needs a Plivo sign-in through the auth proxy.", isError: true };

  // A mistyped id would reach the assistant as an investigation it cannot finish, so check the record first, as the CLI does.
  const op = getOperation(subject.recordOp);
  if (!op) throw new Error(`catalog has no ${subject.recordOp}`);
  const recordReq = buildRequest(op, { path_params: { [subject.idParam]: uuid } }, caller, config.apiBase);
  if ("error" in recordReq) return { value: recordReq.error, isError: true };
  let record: unknown;
  try {
    const res = await callUpstream(recordReq, caller, config.fetchImpl);
    if (res.tokenRejected) {
      config.onTokenRejected?.();
      return { value: { status: res.status, response: res.body }, isError: true };
    }
    if (res.status === 404) return { value: `No ${kind} ${uuid} on this account. Find the id with ${subject.listTool}.`, isError: true };
    if (res.ok) record = res.body;
  } catch {
    // Not fatal: the assistant can still look the record up itself.
  }

  // The auth proxy asks the assistant the question itself; it takes only the id, and a message's channel.
  const ask: Record<string, string> = { uuid };
  const channel = (record as { message_type?: unknown } | undefined)?.message_type;
  if (kind === "message" && (channel === "sms" || channel === "mms" || channel === "whatsapp")) ask.channel = channel;

  let res: Response;
  try {
    res = await (config.fetchImpl ?? fetch)(`${config.apiBase.replace(/\/+$/, "")}/v1/aiassist/diagnose/${kind}`, {
      method: "POST",
      headers: {
        Authorization: caller.authorization,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "User-Agent": "plivo-mcp/0.1",
        "X-Client-Type": "mcp",
      },
      body: JSON.stringify(ask),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { value: `The assistant ${isTimeout(e) ? "did not answer in time" : "could not be reached"}. Try again later.`, isError: true };
  }

  if (!res.ok) {
    const body = await readCapped(res.body, 4_000).catch(() => "");
    if (res.status === 401 && /\binvalid_token\b/.test(res.headers.get("WWW-Authenticate") ?? "")) config.onTokenRejected?.();
    if (res.status === 429) return { value: "Plivo's diagnose limit for this account is reached. Try again in a minute.", isError: true };
    return { value: { status: res.status, response: parseJSON(body) }, isError: true };
  }

  const { text, failure } = await readStream(res.body);
  const turn = readTurn(text);
  const notes: string[] = [];
  if (turn.ticket === "filed") notes.push("The assistant filed a Plivo support ticket for this.");
  if (turn.ticket === "failed") notes.push("The assistant tried to file a Plivo support ticket; it was not filed.");
  if (turn.ticket === "unknown") notes.push("The assistant started filing a Plivo support ticket; whether it was filed is unknown.");
  if (failure) notes.push(`The assistant ${failure === "timeout" ? "did not finish in time" : "stopped answering"}; this is what arrived.`);
  else if (!turn.finished) notes.push("The assistant's answer was cut off.");

  const answer = turn.answer || turn.finalAnswer;
  const result: Record<string, unknown> = { [subject.idParam]: uuid };
  if (answer) result.answer = answer;
  else result.error = turn.error || "The assistant returned no answer.";
  const incomplete = /^[\s>*_#`-]*ANALYSIS_INCOMPLETE:\s*(.*)$/m.exec(answer);
  if (incomplete) result.incomplete = incomplete[1].trim() || true;
  if (notes.length) result.notes = notes;
  return { value: result, isError: !answer || (turn.error !== "" && !turn.finished) };
}

/** Reads the stream as it arrives, keeping what came before a timeout or a dropped connection. */
async function readStream(body: ReadableStream<Uint8Array> | null): Promise<{ text: string; failure?: "timeout" | "dropped" }> {
  if (!body) return { text: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < MAX_STREAM_BYTES) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode() };
      const chunk = value.subarray(0, MAX_STREAM_BYTES - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    reader.cancel().catch(() => {});
    return { text };
  } catch (e) {
    return { text, failure: isTimeout(e) ? "timeout" : "dropped" };
  }
}

interface Turn {
  answer: string;
  finalAnswer: string;
  error: string;
  ticket: "" | "unknown" | "filed" | "failed";
  finished: boolean;
}

interface Tickets {
  pending: number;
  filed: boolean;
  failed: boolean;
}

/** Reads the assistant's SSE events the way the CLI does: tokens build the answer, a full message replaces it. */
export function readTurn(stream: string): Turn {
  const turn: Turn = { answer: "", finalAnswer: "", error: "", ticket: "", finished: false };
  const tickets: Tickets = { pending: 0, filed: false, failed: false };
  // The text after the last blank line is a frame the stream cut short.
  for (const frame of stream.split(/\r?\n\r?\n/).slice(0, -1)) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    const payload = parseJSON(data.join("\n"));
    if (!isRecord(payload)) continue;
    const inner = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
    const field = (k: string) => (isRecord(inner) && typeof inner[k] === "string" ? (inner[k] as string) : "");
    switch (event) {
      case "token":
        turn.answer += field("text");
        break;
      case "message":
      case "result":
        turn.answer = field("text");
        break;
      case "tool_call":
        if (field("name") === ESCALATE_TOOL) tickets.pending++;
        break;
      case "tool_output":
        if (field("name") === ESCALATE_TOOL) {
          tickets.pending = Math.max(0, tickets.pending - 1);
          if (isRecord(inner) && inner.success === true) tickets.filed = true;
          else if (isRecord(inner) && inner.success === false) tickets.failed = true;
        }
        break;
      case "final":
        turn.finalAnswer = field("answer");
        turn.finished = true;
        break;
      case "done":
        turn.finished = true;
        break;
      case "error":
        turn.error = field("error") || "The assistant failed.";
        break;
    }
  }
  // Tool results carry no call id, only the name, so attempts are matched by count.
  turn.ticket = tickets.filed ? "filed" : tickets.pending > 0 ? "unknown" : tickets.failed ? "failed" : "";
  return turn;
}

function parseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}
