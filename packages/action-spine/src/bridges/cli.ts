import type { ActionEnvelopeRequest, ActionEnvelopeResult, ActionExecutorPort, ActionRegistryPort } from "../ports";

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliBridgeOptions<TScope extends string = string> {
  registry: ActionRegistryPort<TScope>;
  executor: ActionExecutorPort;
}

interface ParsedArgs {
  action?: string;
  args: Record<string, unknown>;
  dryRun: boolean;
  executeWrite: boolean;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: action-spine <action> <json-args> [--dry-run|--execute-write]",
    "",
    "Examples:",
    "  action-spine task.list '{}'",
    "  action-spine task.create '{\"title\":\"Review\"}' --dry-run",
  ].join("\n");
}

function parseJsonArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("json-args must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const dryRun = argv.includes("--dry-run");
  const executeWrite = argv.includes("--execute-write");
  const help = argv.includes("--help") || argv.includes("-h");
  const positional = argv.filter(arg => !arg.startsWith("--"));
  return {
    action: positional[0],
    args: parseJsonArgs(positional[1]),
    dryRun,
    executeWrite,
    help,
  };
}

function text(result: ActionEnvelopeResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function createCliBridge<TScope extends string = string>(
  options: CliBridgeOptions<TScope>,
): { run(argv: string[]): Promise<CliRunResult> } {
  return {
    async run(argv: string[]) {
      let parsed: ParsedArgs;
      try {
        parsed = parseArgs(argv);
      } catch (error: any) {
        return { exitCode: 2, stdout: "", stderr: `${error.message}\n${usage()}\n` };
      }

      if (parsed.help || !parsed.action) {
        return { exitCode: parsed.help ? 0 : 2, stdout: `${usage()}\n`, stderr: "" };
      }

      const [surface] = options.registry.surface().filter(action => action.id === parsed.action);
      if (!surface) {
        return {
          exitCode: 1,
          stdout: text({ ok: false, action: parsed.action, action_version: options.registry.version, error: `Unknown action: ${parsed.action}` }),
          stderr: "",
        };
      }

      const validation = options.registry.validate(parsed.action, parsed.args);
      if (!validation.valid) {
        return {
          exitCode: 1,
          stdout: text({ ok: false, action: parsed.action, action_version: options.registry.version, error: `Validation: ${validation.errors.join("; ")}` }),
          stderr: "",
        };
      }

      if (surface.category === "act" && !parsed.executeWrite) {
        if (!parsed.dryRun) {
          return {
            exitCode: 1,
            stdout: text({ ok: false, action: parsed.action, action_version: options.registry.version, error: "Mutation actions require --dry-run or --execute-write" }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: text({
            ok: true,
            action: parsed.action,
            action_version: options.registry.version,
            status: 200,
            data: { dry_run: true, category: surface.category, args: parsed.args },
          }),
          stderr: "",
        };
      }

      const envelope: ActionEnvelopeRequest = {
        action: parsed.action,
        category: surface.category,
        args: parsed.args,
      };
      const result = await options.executor.execute(envelope);
      if (!result) {
        return {
          exitCode: 1,
          stdout: text({ ok: false, action: parsed.action, action_version: options.registry.version, error: "Action is registered but not available through the injected executor" }),
          stderr: "",
        };
      }

      const ok = result.status >= 200 && result.status < 300;
      return {
        exitCode: ok ? 0 : 1,
        stdout: text({
          ok,
          action: parsed.action,
          action_version: options.registry.version,
          status: result.status,
          data: ok ? result.data : undefined,
          error: ok ? undefined : JSON.stringify(result.data),
        }),
        stderr: "",
      };
    },
  };
}
