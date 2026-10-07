import { TOOL_POLICIES, type HarnessConfig, type ToolDefinition, type ToolPolicy } from "../core/types.js";

function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, { type: "null" }] };
}

const DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List files below a workspace-relative directory.",
    minimumPolicy: "read",
    parameters: {
      type: "object",
      properties: {
        path: nullable({ type: "string", description: "Workspace-relative directory; null defaults to ." }),
        maxDepth: nullable({ type: "integer", minimum: 0, maximum: 10 })
      },
      required: ["path", "maxDepth"],
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
        startLine: nullable({ type: "integer", minimum: 1 }),
        endLine: nullable({ type: "integer", minimum: 1 })
      },
      required: ["path", "startLine", "endLine"],
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
        path: nullable({ type: "string" }),
        maxResults: nullable({ type: "integer", minimum: 1, maximum: 500 })
      },
      required: ["query", "path", "maxResults"],
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
        replaceAll: nullable({ type: "boolean" })
      },
      required: ["path", "oldText", "newText", "replaceAll"],
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
        timeoutMs: nullable({ type: "integer", minimum: 1 })
      },
      required: ["command", "timeoutMs"],
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
