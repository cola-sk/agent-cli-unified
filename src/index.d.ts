export interface AgentDefinition {
  id: string;
  aliases: string[];
  binary: string;
  label: string;
  subLabel: string;
  type: string;
  versionFlag: string;
}

export interface DetectedAgent {
  id: string;
  label: string;
  subLabel: string;
  type: string;
  binary: string;
  available: boolean;
  executablePath: string | null;
  version: string | null;
}

export interface CliOptions {
  bypassConfirmations?: boolean;
  disableUpdateCheck?: boolean;
  skipGitRepoCheck?: boolean;
  includeHookEvents?: boolean;
  verbose?: boolean;
  print?: boolean;
  geminiPromptStyle?: 'flag' | 'positional';
  [key: string]: any;
}

export interface SandboxOptions {
  restrictToWorkspace?: boolean;
}

export interface Attachment {
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface BuildCliInvocationOptions {
  agent?: string;
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  model?: string;
  commandPath?: string;
  argsTemplate?: string[];
  argsOverride?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
  sandbox?: SandboxOptions;
  cliOptions?: CliOptions;
  findExecutable?: (binary: string) => string | null;
}

export interface CliInvocation {
  agent: string;
  label: string;
  binary: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
}

export interface RunCliAgentOptions extends BuildCliInvocationOptions {
  timeoutMs?: number;
  attachments?: Attachment[];
  onEvent?: (event: any) => void;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface RunCliAgentResult {
  invocation: CliInvocation;
  exitCode: number | null;
  signal: string | null;
  ok: boolean;
  stdout: string;
  stderr: string;
  events: any[];
  timedOut: boolean;
  timeoutMs: number | null;
}

export const AGENT_DEFINITIONS: Record<string, AgentDefinition>;
export function normalizeAgent(agent?: string): string;
export function resolveCwd(cwd?: string): string;
export function findExecutable(binary: string): string | null;
export function getExecutableVersion(execPath: string, versionFlag?: string): string | null;
export function detectCliAgents(options?: {
  findExecutable?: (binary: string) => string | null;
  getVersion?: (execPath: string, versionFlag?: string) => string | null;
}): DetectedAgent[];
export function buildCliInvocation(options: BuildCliInvocationOptions): CliInvocation;
export function buildAgentArgs(agentId: string, payload: {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  model?: string;
  cliOptions?: CliOptions;
}): string[];
export function parseAgentEvent(line: string): any;
export function runCliAgent(options: RunCliAgentOptions): Promise<RunCliAgentResult>;

export function materializeImageAttachments(attachments: Attachment[]): {
  dirPath: string | null;
  files: Array<{ filePath: string; mimeType: string; name: string }>;
};
export function buildPromptWithImageFiles(prompt: string, files: Array<{ filePath: string; mimeType: string }>): string;
export function isAttemptingUnauthorizedAccess(toolName: string, input: any, workspacePath: string): boolean;
export function explicitlyRequestsExternalAccess(userContent: string, workspacePath: string): boolean;
