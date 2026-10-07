import { TOOL_POLICIES, type HarnessConfig, type ToolDefinition, type ToolPolicy } from "../core/types.js";

const DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List files below a workspace-relative directory.",
    minimumPolicy: "read",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory; defaults to ." },
        maxDepth: { type: "integer", minimum: 0, maximum: 10 }
      },
      additionalProperties: false
    }
  },
  {
    name: "read_file",
    description: "Read all or a line range from a workspace-relative text file.",
    minimumPolicy: "read",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "search_text",
    description: "Search plain text recursively below a workspace-relative path.",
    minimumPolicy: "read",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        path: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 500 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "write_file",
    description: "Create or replace one workspace-relative UTF-8 file.",
    minimumPolicy: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    name: "replace_in_file",
    description: "Replace an exact string in a workspace-relative UTF-8 file.",
    minimumPolicy: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" }
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false
    }
  },
  {
    name: "run_command",
    description: "Run one command in the workspace. This is policy-gated, not OS-sandboxed.",
    minimumPolicy: "shell",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1 }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
];

export function toolDefinitions(config: HarnessConfig, policy: ToolPolicy): ToolDefinition[] {
  const ceiling = TOOL_POLICIES.indexOf(policy);
  const enabled = new Set(config.tools.enabled);
  return DEFINITIONS.filter(
    (definition) => enabled.has(definition.name as never) &&
      TOOL_POLICIES.indexOf(definition.minimumPolicy) <= ceiling
  );
}

export function toolDefinition(name: string): ToolDefinition | undefined {
  return DEFINITIONS.find((definition) => definition.name === name);
}
