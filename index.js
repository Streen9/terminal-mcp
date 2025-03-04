import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { spawn, exec } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// Enhanced Prompt for Claude when using the Terminal MCP
const CLAUDE_TERMINAL_PROMPT = `
# Terminal MCP Instructions for Claude

You now have access to the user's terminal/PowerShell through this Model Context Protocol. This gives you the ability to execute commands, start processes, and interact with the system.

## How to Use This Capability

1. When the user asks for help with a task that requires terminal commands:
   - Think step-by-step about what commands would be needed
   - Explain what you're planning to do before executing commands
   - Show the exact commands you'll run for the user's review
   - Use the appropriate MCP function to execute the commands

2. Command Selection Guidelines:
   - For quick commands with immediate output, use "run-command"
   - For long-running processes (servers, watching files, etc.), use "start-process"
   - Check process output with "get-process-output"
   - Stop processes with "stop-process" when they're no longer needed
   - List all running processes with "list-processes"

3. Security and Safety:
   - Never execute commands that could harm the user's system
   - Avoid commands that delete files unless explicitly requested
   - Do not access sensitive system areas or attempt privilege escalation
   - Always use relative paths unless absolute paths are necessary
   - Verify directories exist before running commands in them

4. Best Practices:
   - First check the system environment when needed (version of tools, OS, etc.)
   - Provide clear explanations of command outputs
   - Suggest next steps based on command results
   - Help troubleshoot any errors that occur
   - Keep track of process IDs for long-running processes

5. Example Contexts:
   - Development: project setup, dependency installation, testing, building
   - System administration: checking resources, configuring settings
   - File operations: organizing files, searching content, checking stats
   - Network: connectivity tests, service discovery
   - Application management: starting/stopping services, checking status

Remember that you're working directly with the user's system, so always be transparent about what you're doing and why.
`;

// Initialize logging
const LOG_DIR = "logs";
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

const getCurrentTimestamp = () => {
  return new Date().toISOString().replace(/[:.]/g, "-");
};

const logToFile = (data, type = "json") => {
  const timestamp = getCurrentTimestamp();
  const logEntry = {
    timestamp,
    ...data,
  };

  // JSON logging
  const jsonLogPath = path.join(LOG_DIR, "terminal-mcp-logs.json");
  let jsonLogs = [];
  if (fs.existsSync(jsonLogPath)) {
    try {
      const fileContent = fs.readFileSync(jsonLogPath, "utf8");
      // Only attempt to parse if there's actual content
      if (fileContent && fileContent.trim()) {
        jsonLogs = JSON.parse(fileContent);
      }
    } catch (error) {
      // If parsing fails, log the error but continue with an empty array
      console.error(`Error parsing JSON log file: ${error.message}`);
      // Optionally create a backup of the corrupted file
      if (fs.existsSync(jsonLogPath)) {
        const backupPath = `${jsonLogPath}.backup-${getCurrentTimestamp()}`;
        fs.copyFileSync(jsonLogPath, backupPath);
        console.error(`Corrupted log file backed up to ${backupPath}`);
      }
    }
  }
  jsonLogs.push(logEntry);
  fs.writeFileSync(jsonLogPath, JSON.stringify(jsonLogs, null, 2));

  // Rest of the function remains the same...
  // Text logging
  const txtLogPath = path.join(LOG_DIR, "terminal-mcp-logs.txt");
  const txtLogEntry = `[${timestamp}] ${JSON.stringify(data)}\n`;
  fs.appendFileSync(txtLogPath, txtLogEntry);

  // Detailed conversation logging
  const conversationLogPath = path.join(
    LOG_DIR,
    "terminal-mcp-conversation.txt"
  );
  let logContent = `[${timestamp}] `;
  if (data.event === "call_tool") {
    logContent += `INPUT: ${data.name} with args: ${JSON.stringify(
      data.args
    )}\n`;
  } else if (data.event === "tool_response") {
    logContent += `OUTPUT: ${JSON.stringify(data.response)}\n`;
  } else {
    logContent += `EVENT: ${data.event} - ${JSON.stringify(data)}\n`;
  }
  fs.appendFileSync(conversationLogPath, logContent);
};

// Keep track of running processes
const runningProcesses = new Map();

// Execute terminal commands
async function executeCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        return reject({ error, stderr });
      }
      resolve({ stdout, stderr });
    });
  });
}

// Start a long-running process and return its output stream
function startProcess(command, args, cwd) {
  const childProcess = spawn(command, args, {
    cwd,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "true" },
  });

  let output = "";
  let errorOutput = "";

  childProcess.stdout.on("data", (data) => {
    const chunk = data.toString();
    output += chunk;
    // Log real-time output
    logToFile({
      event: "process_output",
      processId: processId,
      output: chunk,
      command: command,
    });
  });

  childProcess.stderr.on("data", (data) => {
    const chunk = data.toString();
    errorOutput += chunk;
    // Log real-time error output
    logToFile({
      event: "process_error",
      processId: processId,
      errorOutput: chunk,
      command: command,
    });
  });

  const processId = Math.random().toString(36).substring(2, 15);

  runningProcesses.set(processId, {
    process: childProcess,
    command,
    args,
    cwd,
    output,
    errorOutput,
    startTime: new Date(),
    processId,
  });

  return processId;
}

// Tool handlers
async function handleRunCommand(params) {
  try {
    const { command, directory } = params;

    if (!command) {
      throw new Error("Command is required");
    }

    // Determine directory
    const workingDir = directory || process.cwd();

    // Check if directory exists
    if (!fs.existsSync(workingDir)) {
      throw new Error(`Directory ${workingDir} does not exist`);
    }

    // Log the command before execution
    logToFile({
      event: "command_execution",
      command: command,
      directory: workingDir,
    });

    // Run the command
    const result = await executeCommand(command, { cwd: workingDir });

    // Log the command result
    const response = {
      command: command,
      directory: workingDir,
      output: result.stdout,
      stderr: result.stderr || "",
    };

    logToFile({
      event: "tool_response",
      name: "run-command",
      response,
    });

    return response;
  } catch (error) {
    const errorResponse = {
      error: `Error executing command: ${error.message}`,
      stderr: error.stderr || "",
    };

    logToFile({
      event: "command_error",
      command: params.command,
      error: error.message,
    });

    return errorResponse;
  }
}

async function handleStartProcess(params) {
  try {
    const { command, directory } = params;

    if (!command) {
      throw new Error("Command is required");
    }

    // Determine directory
    const workingDir = directory || process.cwd();

    // Check if directory exists
    if (!fs.existsSync(workingDir)) {
      throw new Error(`Directory ${workingDir} does not exist`);
    }

    // Log the process start command
    logToFile({
      event: "process_start",
      command: command,
      directory: workingDir,
    });

    // Start the process
    const processId = startProcess(command, [], workingDir);

    const response = {
      message: `Started process: ${command}`,
      processId: processId,
      directory: workingDir,
    };

    logToFile({
      event: "tool_response",
      name: "start-process",
      response,
    });

    return response;
  } catch (error) {
    const errorResponse = {
      error: `Error starting process: ${error.message}`,
    };

    logToFile({
      event: "process_start_error",
      command: params.command,
      error: error.message,
    });

    return errorResponse;
  }
}

async function handleGetProcessOutput(params) {
  try {
    const { processId } = params;

    if (!processId) {
      throw new Error("Process ID is required");
    }

    if (!runningProcesses.has(processId)) {
      throw new Error(`Process with ID ${processId} not found`);
    }

    const processInfo = runningProcesses.get(processId);
    const isRunning = processInfo.process.exitCode === null;

    const response = {
      processId: processId,
      command: `${processInfo.command} ${processInfo.args.join(" ")}`,
      directory: processInfo.cwd,
      isRunning: isRunning,
      exitCode: processInfo.process.exitCode,
      output: processInfo.output,
      errorOutput: processInfo.errorOutput,
      startTime: processInfo.startTime.toISOString(),
      runTime: `${Math.floor(
        (new Date() - processInfo.startTime) / 1000
      )} seconds`,
    };

    logToFile({
      event: "tool_response",
      name: "get-process-output",
      response,
    });

    return response;
  } catch (error) {
    const errorResponse = {
      error: `Error getting process output: ${error.message}`,
    };

    logToFile({
      event: "get_process_error",
      processId: params.processId,
      error: error.message,
    });

    return errorResponse;
  }
}

async function handleStopProcess(params) {
  try {
    const { processId } = params;

    if (!processId) {
      throw new Error("Process ID is required");
    }

    if (!runningProcesses.has(processId)) {
      throw new Error(`Process with ID ${processId} not found`);
    }

    const processInfo = runningProcesses.get(processId);

    // Log the process stop
    logToFile({
      event: "process_stop",
      processId: processId,
      command: processInfo.command,
    });

    // Kill the process
    processInfo.process.kill();

    const response = {
      message: `Process ${processId} stopped`,
      command: `${processInfo.command} ${processInfo.args.join(" ")}`,
      directory: processInfo.cwd,
    };

    logToFile({
      event: "tool_response",
      name: "stop-process",
      response,
    });

    return response;
  } catch (error) {
    const errorResponse = {
      error: `Error stopping process: ${error.message}`,
    };

    logToFile({
      event: "stop_process_error",
      processId: params.processId,
      error: error.message,
    });

    return errorResponse;
  }
}

async function handleListProcesses() {
  try {
    const processes = [];

    for (const [processId, processInfo] of runningProcesses.entries()) {
      const isRunning = processInfo.process.exitCode === null;

      processes.push({
        processId: processId,
        command: `${processInfo.command} ${processInfo.args.join(" ")}`,
        directory: processInfo.cwd,
        isRunning: isRunning,
        exitCode: processInfo.process.exitCode,
        startTime: processInfo.startTime.toISOString(),
        runTime: `${Math.floor(
          (new Date() - processInfo.startTime) / 1000
        )} seconds`,
      });
    }

    const response = {
      processes: processes,
      count: processes.length,
    };

    logToFile({
      event: "tool_response",
      name: "list-processes",
      response,
    });

    return response;
  } catch (error) {
    const errorResponse = {
      error: `Error listing processes: ${error.message}`,
    };

    logToFile({
      event: "list_processes_error",
      error: error.message,
    });

    return errorResponse;
  }
}

// Server setup
const server = new Server(
  {
    name: "terminal-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define schemas
const RunCommandSchema = z.object({
  command: z.string(),
  directory: z.string().optional(),
});

const StartProcessSchema = z.object({
  command: z.string(),
  directory: z.string().optional(),
});

const GetProcessOutputSchema = z.object({
  processId: z.string(),
});

const StopProcessSchema = z.object({
  processId: z.string(),
});

// Tool request handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Log the Claude prompt when tools are first listed (typically at initialization)
  logToFile({
    event: "claude_prompt",
    prompt: CLAUDE_TERMINAL_PROMPT,
  });

  const response = {
    tools: [
      {
        name: "run-command",
        description: "Run a terminal command and get immediate output",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Command to execute (PowerShell/terminal)",
            },
            directory: {
              type: "string",
              description:
                "Directory to run the command in (defaults to current directory)",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "start-process",
        description: "Start a long-running process",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Command to execute (PowerShell/terminal)",
            },
            directory: {
              type: "string",
              description:
                "Directory to run the command in (defaults to current directory)",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "get-process-output",
        description: "Get the output from a running or completed process",
        inputSchema: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "ID of the process to get output from",
            },
          },
          required: ["processId"],
        },
      },
      {
        name: "stop-process",
        description: "Stop a running process",
        inputSchema: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "ID of the process to stop",
            },
          },
          required: ["processId"],
        },
      },
      {
        name: "list-processes",
        description: "List all running processes",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
    systemPrompt: CLAUDE_TERMINAL_PROMPT,
  };

  logToFile({ event: "list_tools", response });
  return response;
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
  const { name, arguments: args } = request.params;
  logToFile({ event: "call_tool", name, args });

  try {
    let result;

    switch (name) {
      case "run-command":
        const commandArgs = RunCommandSchema.parse(args);
        result = await handleRunCommand(commandArgs);
        break;

      case "start-process":
        const startArgs = StartProcessSchema.parse(args);
        result = await handleStartProcess(startArgs);
        break;

      case "get-process-output":
        const outputArgs = GetProcessOutputSchema.parse(args);
        result = await handleGetProcessOutput(outputArgs);
        break;

      case "stop-process":
        const stopArgs = StopProcessSchema.parse(args);
        result = await handleStopProcess(stopArgs);
        break;

      case "list-processes":
        result = await handleListProcesses();
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return createTextResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessage = `Invalid arguments: ${error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ")}`;

      logToFile({
        event: "validation_error",
        name,
        args,
        error: errorMessage,
      });

      throw new Error(errorMessage);
    }

    logToFile({
      event: "error",
      name,
      args,
      error: error.message,
    });

    throw error;
  }
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("Terminal MCP Server running on stdio");

  // Log server start with system info
  logToFile({
    event: "server_start",
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    cwd: process.cwd(),
  });
});

const createTextResponse = (text) => ({
  content: [{ type: "text", text }],
});

// Clean up processes on exit
process.on("exit", () => {
  // Log shutdown event
  logToFile({
    event: "server_shutdown",
    activeProcesses: runningProcesses.size,
  });

  for (const [processId, processInfo] of runningProcesses.entries()) {
    try {
      processInfo.process.kill();
      logToFile({
        event: "process_terminated_on_exit",
        processId,
        command: processInfo.command,
      });
    } catch (error) {
      console.error(`Failed to kill process ${processId}:`, error);
      logToFile({
        event: "process_termination_failed",
        processId,
        error: error.message,
      });
    }
  }
});

process.on("SIGINT", () => {
  logToFile({
    event: "sigint_received",
  });
  process.exit(0);
});

process.on("SIGTERM", () => {
  logToFile({
    event: "sigterm_received",
  });
  process.exit(0);
});
