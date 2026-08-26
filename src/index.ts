import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const KIRO_CLI_CANDIDATES = [
  process.env.KIRO_CLI_PATH,
  join(homedir(), ".local", "bin", "kiro-cli-chat"),
  "kiro-cli-chat",
].filter((candidate): candidate is string => Boolean(candidate));

const parameters = Type.Object({
  prompt: Type.String({ description: "Complete task or question for Kiro to handle in the current project." }),
  agent: Type.Optional(Type.String({ description: "Optional Kiro agent/context profile." })),
  model: Type.Optional(Type.String({ description: "Optional Kiro model identifier." })),
  effort: Type.Optional(Type.String({ description: "Optional Kiro effort level, such as low, medium, high, xhigh, or max." })),
  mode: Type.Optional(StringEnum(["default", "spec"] as const, { description: "Optional Kiro V3 mode." })),
  resume: Type.Optional(Type.Boolean({ description: "Resume Kiro's most recent conversation for this directory." })),
  trust_all_tools: Type.Optional(Type.Boolean({ description: "Allow Kiro to run its tools without interactive confirmation. Defaults to true because this invocation is headless." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000, description: "Maximum runtime in milliseconds (default: 15 minutes)." })),
});

async function findKiroCli(): Promise<string> {
  for (const candidate of KIRO_CLI_CANDIDATES) {
    if (candidate.includes("/")) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }

    // Let spawn resolve commands available on PATH.
    return candidate;
  }
  throw new Error("Kiro CLI was not found. Install it or set KIRO_CLI_PATH to the kiro-cli-chat executable.");
}

type KiroStreamEvent = {
  type?: string;
  data?: {
    finalText?: unknown;
    message?: unknown;
    status?: unknown;
    update?: {
      sessionUpdate?: unknown;
      content?: { type?: unknown; text?: unknown };
      toolCall?: { name?: unknown; title?: unknown; kind?: unknown };
    };
  };
};

interface KiroProcessResult {
  finalText: string;
  messageText: string;
  stderr: string;
  code: number;
  killed: boolean;
}

function progressForEvent(event: KiroStreamEvent): string | undefined {
  const update = event.data?.update;
  const kind = update?.sessionUpdate;

  if (kind === "agent_thought_chunk") return "Kiro is thinking";
  if (kind === "agent_message_chunk") return "Kiro is writing the response";
  if (kind === "tool_call") {
    const tool = update.toolCall?.name ?? update.toolCall?.kind;
    return typeof tool === "string" ? `Kiro is using ${tool}` : "Kiro is using a tool";
  }
  if (kind === "tool_call_update") return "Kiro is waiting for a tool result";
  if (kind === "plan") return "Kiro is planning";
  if (event.type === "runFinished") return "Kiro finished";
  return undefined;
}

async function runKiroStreaming(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onProgress: (status: string) => void,
): Promise<KiroProcessResult> {
  if (signal?.aborted) {
    return { finalText: "", messageText: "", stderr: "", code: 130, killed: true };
  }

  const child = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = createInterface({ input: child.stdout });
  const stdoutLines: string[] = [];
  let finalText = "";
  let messageText = "";
  let stderr = "";
  let killed = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const terminate = () => {
    if (settled || killed) return;
    killed = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  };

  const abortHandler = () => terminate();
  signal?.addEventListener("abort", abortHandler, { once: true });
  timer = setTimeout(terminate, timeoutMs);

  output.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    stdoutLines.push(trimmed);

    let event: KiroStreamEvent;
    try {
      event = JSON.parse(trimmed) as KiroStreamEvent;
    } catch {
      // Preserve unexpected output for diagnostics, but do not show it as thinking.
      return;
    }

    const status = progressForEvent(event);
    if (status) onProgress(status);

    if (typeof event.data?.finalText === "string") {
      finalText = event.data.finalText;
    }
    const update = event.data?.update;
    if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
      messageText += update.content.text;
    }
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? (killed ? 130 : 1)));
  }).finally(() => {
    settled = true;
    output.close();
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abortHandler);
  });

  return {
    finalText,
    messageText,
    stderr: stderr || stdoutLines.filter((line) => !line.startsWith("{")).join("\n"),
    code,
    killed,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "kiro_headless",
    label: "Kiro Headless",
    description: `Delegate a task to Kiro CLI headlessly in the current project. Kiro runs with --no-interactive and returns its final text response. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
    promptSnippet: "Delegate a task to Kiro CLI headlessly",
    promptGuidelines: [
      "Use kiro_headless only when the user explicitly asks to delegate work to Kiro CLI or requests a second-agent Kiro pass.",
      "kiro_headless runs Kiro in the current project and, by default, trusts all Kiro tools because it cannot ask interactive permission questions.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const executable = await findKiroCli();
      // stream-json is supported by Kiro's v2/v3 engines and lets Pi show
      // high-level activity without exposing Kiro's private reasoning text.
      const engine = params.mode ? "v3" : "v2";
      const args = [
        "chat",
        "--no-interactive",
        "--output-format",
        "stream-json",
        "--agent-engine",
        engine,
        "--wrap",
        "never",
      ];
      if (params.trust_all_tools !== false) args.push("--trust-all-tools");
      if (params.resume) args.push("--resume");
      if (params.agent) args.push("--agent", params.agent);
      if (params.model) args.push("--model", params.model);
      if (params.effort) args.push("--effort", params.effort);
      if (params.mode) args.push("--mode", params.mode);
      args.push(params.prompt);

      const modelLabel = params.model ?? "Kiro default model";
      const agentLabel = params.agent ? ` (${params.agent})` : "";
      const startedAt = Date.now();
      let lastProgress = "";
      const reportProgress = (status: string) => {
        // Avoid redrawing identical events for every streamed text chunk.
        if (status === lastProgress) return;
        lastProgress = status;
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        onUpdate?.({
          content: [{ type: "text", text: `${status} with ${modelLabel}${agentLabel}... ${elapsed}s` }],
        });
      };
      reportProgress("Kiro is starting");

      const result = await runKiroStreaming(
        executable,
        args,
        ctx.cwd,
        signal,
        params.timeout_ms ?? 900_000,
        reportProgress,
      );

      const fullOutput = [result.finalText || result.messageText, result.stderr]
        .filter(Boolean)
        .join(result.stderr && (result.finalText || result.messageText) ? "\n\n[stderr]\n" : "");
      const truncation = truncateTail(fullOutput || "(Kiro produced no output)", {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncation.content;
      if (truncation.truncated) {
        text = `[Kiro output truncated: showing final ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]\n\n${text}`;
      }
      if (result.killed) text += "\n\n[Kiro process was cancelled or timed out.]";
      if (result.code !== 0) {
        throw new Error(`Kiro CLI exited with code ${result.code}.\n${text}`);
      }

      return {
        content: [{ type: "text", text }],
        details: {
          executable,
          args: args.slice(0, -1),
          exitCode: result.code,
          killed: result.killed,
          truncated: truncation.truncated,
        },
      };
    },
  });
}
