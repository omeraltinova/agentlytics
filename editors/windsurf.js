const { execSync } = require('child_process');

// Windsurf-family variants: Windsurf, Antigravity
const VARIANTS = [
  { id: 'windsurf', matchKey: 'ide', matchVal: 'windsurf', https: false },
  { id: 'windsurf-next', matchKey: 'ide', matchVal: 'windsurf-next', https: false },
  { id: 'antigravity', matchKey: 'appDataDir', matchVal: 'antigravity', https: true },
];

// Antigravity model ID to friendly name mapping
const ANTIGRAVITY_MODEL_MAP = {
  'MODEL_PLACEHOLDER_M1': 'claude-3-5-sonnet-20241022',
  'MODEL_PLACEHOLDER_M2': 'claude-3-5-sonnet-20241022',
  'MODEL_PLACEHOLDER_M3': 'claude-3-5-sonnet-20241022',
  'MODEL_PLACEHOLDER_M4': 'claude-3-5-haiku-20241022',
  'MODEL_PLACEHOLDER_M5': 'claude-3-5-haiku-20241022',
  'MODEL_PLACEHOLDER_M6': 'claude-3-5-haiku-20241022',
  'MODEL_PLACEHOLDER_M7': 'claude-3-5-sonnet-20241022',
  'MODEL_PLACEHOLDER_M8': 'claude-3.5-sonnet',
  'MODEL_PLACEHOLDER_M9': 'claude-3.5-sonnet',
  'MODEL_PLACEHOLDER_M10': 'claude-3.5-sonnet',
  'MODEL_CLAUDE_4_5_SONNET': 'claude-4.5-sonnet',
};

function normalizeAntigravityModel(modelId) {
  if (!modelId) return null;
  return ANTIGRAVITY_MODEL_MAP[modelId] || modelId;
}

// ============================================================
// Cross-platform process utilities
// ============================================================

const IS_WINDOWS = process.platform === 'win32';

function getProcessList() {
  try {
    if (IS_WINDOWS) {
      // wmic provides CSV-formatted process data
      const output = execSync('wmic process get CommandLine,ProcessId /format:csv', {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      // Parse CSV: skip header, split by comma
      const lines = output.split('\n').slice(1);
      return lines.map(line => {
        const parts = line.split(',');
        if (parts.length < 2) return null;
        const commandLine = parts.slice(0, -1).join(',').trim().replace(/^"|"$/g, '');
        const pid = parts[parts.length - 1].trim();
        return { commandLine, pid };
      }).filter(Boolean);
    } else {
      // ps aux on Unix-like systems
      const output = execSync('ps aux', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      return output.split('\n').slice(1).map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) return null;
        const pid = parts[1];
        const commandLine = parts.slice(10).join(' ');
        return { commandLine, pid };
      }).filter(Boolean);
    }
  } catch { return []; }
}

function getListeningPorts(pid) {
  try {
    if (IS_WINDOWS) {
      // netstat -ano shows PID in the last column
      const output = execSync(`netstat -ano | findstr ${pid}`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      const ports = [];
      for (const line of output.split('\n')) {
        // Match: 127.0.0.1:PORT ... LISTENING PID
        // Check if line ends with the PID we're looking for
        if (!line.trim().endsWith(pid)) continue;
        const match = line.match(/127\.0\.0\.1:(\d+).*LISTENING/);
        if (match) {
          ports.push(parseInt(match[1]));
        }
      }
      return ports;
    } else {
      // lsof on Unix-like systems
      const output = execSync(`lsof -i TCP -P -n -a -p ${pid} 2>/dev/null`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      const ports = [];
      for (const line of output.split('\n')) {
        const match = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
        if (match) {
          ports.push(parseInt(match[1]));
        }
      }
      return ports;
    }
  } catch { return []; }
}

// ============================================================
// Find running Windsurf/Antigravity language server (port + CSRF token)
// ============================================================

let _lsCache = null;

function findLanguageServers() {
  if (_lsCache) return _lsCache;
  _lsCache = [];

  // Language server executable name varies by platform
  // Windows: language_server_windows_x64.exe, language_server_windows_x.exe, etc.
  const serverProcessName = IS_WINDOWS
    ? 'language_server_windows'
    : process.platform === 'darwin'
      ? 'language_server_macos'
      : 'language_server_linux';

  for (const proc of getProcessList()) {
    const { commandLine, pid } = proc;
    if (!commandLine.includes(serverProcessName) || !commandLine.includes('--csrf_token')) continue;

    const csrfMatch = commandLine.match(/--csrf_token\s+(\S+)/);
    const ideMatch = commandLine.match(/--ide_name\s+(\S+)/);
    const appDirMatch = commandLine.match(/--app_data_dir\s+(\S+)/);
    if (!csrfMatch) continue;

    const csrf = csrfMatch[1];
    const ide = ideMatch ? ideMatch[1] : null;
    const appDataDir = appDirMatch ? appDirMatch[1] : null;

    // Antigravity has a separate extension server CSRF token
    const extCsrfMatch = commandLine.match(/--extension_server_csrf_token\s+(\S+)/);

    // Check for explicit server port (Antigravity uses --server_port)
    const serverPortMatch = commandLine.match(/--server_port\s+(\d+)/);

    // Find actual listening ports for this process
    const ports = getListeningPorts(pid);
    if (ports.length === 0) continue;

    // Use explicit server_port if available, otherwise use lowest port
    let port;
    if (serverPortMatch) {
      port = parseInt(serverPortMatch[1], 10);
      // Verify the port is actually listening
      if (!ports.includes(port)) {
        port = Math.min(...ports);
      }
    } else {
      port = Math.min(...ports);
    }

    if (ide || appDataDir) {
      // Antigravity uses HTTPS on --server_port, Windsurf uses HTTP
      const isHttps = appDataDir?.includes('antigravity');
      _lsCache.push({ ide, appDataDir, port, csrf, pid, extCsrf: extCsrfMatch ? extCsrfMatch[1] : null, isHttps });
    }
  }

  return _lsCache;
}

function getLsForVariant(variant) {
  const servers = findLanguageServers();
  let matches;
  if (variant.matchKey === 'appDataDir') {
    matches = servers.filter(s => s.appDataDir?.includes(variant.matchVal));
  } else {
    matches = servers.filter(s => s.ide === variant.matchVal);
  }
  return matches.length > 0 ? matches[0] : null;
}

// ============================================================
// Connect protocol HTTP client for language server RPC
// ============================================================

function callRpc(port, csrf, method, body, isHttps = false, extCsrf = null, useMainCsrf = false) {
  const data = JSON.stringify(body || {});
  const scheme = isHttps ? 'https' : 'http';
  const url = `${scheme}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`;
  const insecure = isHttps ? '-k ' : '';

  // For Antigravity, use main CSRF. For Windsurf, use extension CSRF if available.
  const actualCsrf = useMainCsrf ? csrf : (extCsrf || csrf);

  try {
    const result = execSync(
      `curl -s ${insecure}-X POST ${JSON.stringify(url)} ` +
      `-H "Content-Type: application/json" ` +
      `-H "x-codeium-csrf-token: ${actualCsrf}" ` +
      `-d ${JSON.stringify(data)} ` +
      `--max-time 10`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(result);
  } catch { return null; }
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'windsurf';
const sources = ['windsurf', 'windsurf-next', 'antigravity'];

function getChats() {
  const chats = [];

  for (const variant of VARIANTS) {
    const ls = getLsForVariant(variant);
    if (!ls) continue;

    // Antigravity uses main CSRF, Windsurf uses extension CSRF
    const useMainCsrf = variant.id === 'antigravity';
    const resp = callRpc(ls.port, ls.csrf, 'GetAllCascadeTrajectories', {}, ls.isHttps, ls.extCsrf, useMainCsrf);
    if (!resp || !resp.trajectorySummaries) continue;

    for (const [cascadeId, summary] of Object.entries(resp.trajectorySummaries)) {
      const ws = (summary.workspaces || [])[0];
      const folder = ws?.workspaceFolderAbsoluteUri?.replace('file://', '') || null;
      const rawModel = summary.lastGeneratorModelUid;
      // Normalize Antigravity models so they show correctly in dashboard
      const normalizedModel = variant.id === 'antigravity' && rawModel ? normalizeAntigravityModel(rawModel) : rawModel;
      chats.push({
        source: variant.id,
        composerId: cascadeId,
        name: summary.summary || null,
        createdAt: summary.createdTime ? new Date(summary.createdTime).getTime() : null,
        lastUpdatedAt: summary.lastModifiedTime ? new Date(summary.lastModifiedTime).getTime() : null,
        mode: 'cascade',
        folder,
        encrypted: false,
        bubbleCount: summary.stepCount || 0,
        _port: ls.port,
        _csrf: ls.csrf,
        _extCsrf: ls.extCsrf,
        _isHttps: ls.isHttps,
        _stepCount: summary.stepCount,
        _model: normalizedModel,
        _rawModel: rawModel,
      });
    }
  }

  return chats;
}

function getSteps(chat) {
  if (!chat._port || !chat._csrf) return [];

  // Determine if this is Antigravity based on source
  const isAntigravity = chat.source === 'antigravity';

  // Prefer GetCascadeTrajectorySteps (returns more steps than GetCascadeTrajectory)
  const resp = callRpc(chat._port, chat._csrf, 'GetCascadeTrajectorySteps', {
    cascadeId: chat.composerId,
  }, chat._isHttps, chat._extCsrf, isAntigravity);
  if (resp && resp.steps && resp.steps.length > 0) return resp.steps;

  // Fallback to old method
  const resp2 = callRpc(chat._port, chat._csrf, 'GetCascadeTrajectory', {
    cascadeId: chat.composerId,
  }, chat._isHttps, chat._extCsrf, isAntigravity);
  if (resp2 && resp2.trajectory && resp2.trajectory.steps) return resp2.trajectory.steps;

  return [];
}

/**
 * Get the tail messages beyond the step limit using generatorMetadata.
 * The last generatorMetadata entry with messagePrompts has the conversation context.
 * We find the overlap with step-based messages by matching the last user message content.
 */
function getTailMessages(chat, stepMessages) {
  const isAntigravity = chat.source === 'antigravity';
  const resp = callRpc(chat._port, chat._csrf, 'GetCascadeTrajectory', {
    cascadeId: chat.composerId,
  }, chat._isHttps, chat._extCsrf, isAntigravity);
  if (!resp || !resp.trajectory) return [];

  const gm = resp.trajectory.generatorMetadata || [];
  // Find the last entry that has messagePrompts
  let lastWithMsgs = null;
  for (let i = gm.length - 1; i >= 0; i--) {
    if (gm[i].chatModel && gm[i].chatModel.messagePrompts && gm[i].chatModel.messagePrompts.length > 0) {
      lastWithMsgs = gm[i];
      break;
    }
  }
  if (!lastWithMsgs) return [];

  const mp = lastWithMsgs.chatModel.messagePrompts;

  // Find the last user message from step-based parsing
  let lastUserContent = '';
  for (let i = stepMessages.length - 1; i >= 0; i--) {
    if (stepMessages[i].role === 'user' && stepMessages[i].content.length > 20) {
      lastUserContent = stepMessages[i].content;
      break;
    }
  }
  if (!lastUserContent) return [];

  // Find this message in the messagePrompts (search from end for efficiency)
  const needle = lastUserContent.substring(0, 50);
  let matchIdx = -1;
  for (let i = mp.length - 1; i >= 0; i--) {
    if (mp[i].source === 'CHAT_MESSAGE_SOURCE_USER' && mp[i].prompt && mp[i].prompt.includes(needle)) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx < 0 || matchIdx >= mp.length - 1) return [];

  // Convert everything after the match point to messages
  const tail = [];
  for (let i = matchIdx + 1; i < mp.length; i++) {
    const m = mp[i];
    const src = m.source || '';
    const prompt = m.prompt || '';
    if (!prompt || !prompt.trim()) continue;

    let role;
    if (src === 'CHAT_MESSAGE_SOURCE_USER') role = 'user';
    else if (src === 'CHAT_MESSAGE_SOURCE_SYSTEM') role = 'assistant';
    else if (src === 'CHAT_MESSAGE_SOURCE_TOOL') role = 'tool';
    else continue;

    tail.push({ role, content: prompt });
  }
  return tail;
}

function parseStep(step, isAntigravity = false) {
  const type = step.type || '';
  const meta = step.metadata || {};

  if (type === 'CORTEX_STEP_TYPE_USER_INPUT' && step.userInput) {
    return {
      role: 'user',
      content: step.userInput.userResponse || step.userInput.items?.map(i => i.text).join('') || '',
    };
  }

  if (type === 'CORTEX_STEP_TYPE_ASK_USER_QUESTION' && step.askUserQuestion) {
    const q = step.askUserQuestion;
    return {
      role: 'user',
      content: q.userResponse || q.question || '',
    };
  }

  if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && step.plannerResponse) {
    const pr = step.plannerResponse;
    const parts = [];
    if (pr.thinking) parts.push(`[thinking] ${pr.thinking}`);
    const text = pr.modifiedResponse || pr.response || pr.textContent || '';
    if (text.trim()) parts.push(text.trim());
    const _toolCalls = [];
    if (pr.toolCalls && pr.toolCalls.length > 0) {
      for (const tc of pr.toolCalls) {
        let args = {};
        try { args = tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {}; } catch { args = {}; }
        const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
        parts.push(`[tool-call: ${tc.name}(${argKeys})]`);
        _toolCalls.push({ name: tc.name, args });
      }
    }
    if (parts.length > 0) {
      // Try both generatorModel (Antigravity) and generatorModelUid (Windsurf)
      const model = meta.generatorModel || meta.generatorModelUid;
      return {
        role: 'assistant',
        content: parts.join('\n'),
        _model: isAntigravity && model ? normalizeAntigravityModel(model) : model,
        _toolCalls,
      };
    }
    return null;
  }

  // Tool-like step types
  if (type === 'CORTEX_STEP_TYPE_TOOL_EXECUTION' && step.toolExecution) {
    const te = step.toolExecution;
    const toolName = te.toolName || te.name || 'tool';
    const result = te.output || te.result || '';
    const preview = typeof result === 'string' ? result.substring(0, 500) : JSON.stringify(result).substring(0, 500);
    return { role: 'tool', content: `[${toolName}] ${preview}` };
  }

  if (type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && step.runCommand) {
    const rc = step.runCommand;
    const cmd = rc.command || rc.commandLine || '';
    const out = (rc.output || rc.stdout || '').substring(0, 500);
    return { role: 'tool', content: `[run_command] ${cmd}${out ? '\n' + out : ''}` };
  }

  if (type === 'CORTEX_STEP_TYPE_COMMAND_STATUS' && step.commandStatus) {
    const cs = step.commandStatus;
    const out = (cs.output || cs.stdout || '').substring(0, 500);
    return out ? { role: 'tool', content: `[command_status] ${out}` } : null;
  }

  if (type === 'CORTEX_STEP_TYPE_VIEW_FILE' && step.viewFile) {
    const vf = step.viewFile;
    const filePath = vf.filePath || vf.path || '';
    return { role: 'tool', content: `[view_file] ${filePath}` };
  }

  if (type === 'CORTEX_STEP_TYPE_CODE_ACTION' && step.codeAction) {
    const ca = step.codeAction;
    const filePath = ca.filePath || ca.path || '';
    return { role: 'tool', content: `[code_action] ${filePath}` };
  }

  if (type === 'CORTEX_STEP_TYPE_GREP_SEARCH' && step.grepSearch) {
    const gs = step.grepSearch;
    const query = gs.query || gs.pattern || '';
    return { role: 'tool', content: `[grep_search] ${query}` };
  }

  if (type === 'CORTEX_STEP_TYPE_LIST_DIRECTORY' && step.listDirectory) {
    const ld = step.listDirectory;
    const dir = ld.directoryPath || ld.path || '';
    return { role: 'tool', content: `[list_directory] ${dir}` };
  }

  if (type === 'CORTEX_STEP_TYPE_MCP_TOOL' && step.mcpTool) {
    const mt = step.mcpTool;
    const name = mt.toolName || mt.name || 'mcp_tool';
    return { role: 'tool', content: `[${name}]` };
  }

  // Skip non-content steps
  if (type === 'CORTEX_STEP_TYPE_CHECKPOINT' || type === 'CORTEX_STEP_TYPE_RETRIEVE_MEMORY' ||
      type === 'CORTEX_STEP_TYPE_MEMORY' || type === 'CORTEX_STEP_TYPE_TODO_LIST' ||
      type === 'CORTEX_STEP_TYPE_EXIT_PLAN_MODE' || type === 'CORTEX_STEP_TYPE_PROXY_WEB_SERVER') {
    return null;
  }

  return null;
}

function getMessages(chat) {
  const steps = getSteps(chat);
  const isAntigravity = chat.source === 'antigravity';
  const messages = [];
  for (const step of steps) {
    const msg = parseStep(step, isAntigravity);
    if (msg) messages.push(msg);
  }

  // If steps are truncated, fill in the tail from generatorMetadata
  const tail = getTailMessages(chat, messages);
  if (tail.length > 0) {
    messages.push(...tail);
  }

  return messages;
}

function resetCache() { _lsCache = null; }

module.exports = { name, sources, getChats, getMessages, resetCache };
