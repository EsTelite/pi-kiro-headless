import { access } from "node:fs/promises";
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

    // Let pi.exec resolve commands available on PATH.
    return candidate;
  }
  throw new Error("Kiro CLI was not found. Install it or set KIRO_CLI_PATH to the kiro-cli-chat executable.");
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
      const args = ["chat", "--no-interactive", "--wrap", "never"];
      if (params.trust_all_tools !== false) args.push("--trust-all-tools");
      if (params.resume) args.push("--resume");
      if (params.agent) args.push("--agent", params.agent);
      if (params.model) args.push("--model", params.model);
      if (params.effort) args.push("--effort", params.effort);
      if (params.mode) args.push("--v3", "--mode", params.mode);
      args.push(params.prompt);

      const modelLabel = params.model ?? "Kiro default model";
      const agentLabel = params.agent ? ` (${params.agent})` : "";
      onUpdate?.({
        content: [{ type: "text", text: `Kiro is working with ${modelLabel}${agentLabel}...` }],
      });
      const result = await pi.exec(executable, args, {
        signal,
        timeout: params.timeout_ms ?? 900_000,
        cwd: ctx.cwd,
      });

      const fullOutput = [result.stdout, result.stderr].filter(Boolean).join(result.stderr && result.stdout ? "\n\n[stderr]\n" : "");
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
