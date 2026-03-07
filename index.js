#!/usr/bin/env node

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const PORT = process.env.PORT || 4637;
const RELAY_PORT = process.env.RELAY_PORT || 4638;
const noCache = process.argv.includes('--no-cache');
const collectOnly = process.argv.includes('--collect');
const isRelay = process.argv.includes('--relay');
const joinIndex = process.argv.indexOf('--join');
const isJoin = joinIndex !== -1;

// ── Relay mode ───────────────────────────────────────────────
if (isRelay) {
  const { initRelayDb, getRelayDb, createRelayApp } = require('./relay-server');
  const { wireMcpToExpress } = require('./mcp-server');

  console.log('');
  console.log(chalk.bold('  ⚡ Agentlytics Relay'));
  console.log(chalk.dim('  Multi-user context sharing server'));
  console.log('');

  initRelayDb();
  console.log(chalk.green('  ✓ Relay database initialized'));

  const app = createRelayApp();
  wireMcpToExpress(app, getRelayDb);
  console.log(chalk.green('  ✓ MCP server registered'));

  app.listen(RELAY_PORT, () => {
    const localIp = getLocalIp();
    const relayUrl = `http://${localIp}:${RELAY_PORT}`;

    console.log('');
    console.log(chalk.green(`  ✓ Relay server running on port ${RELAY_PORT}`));
    console.log('');
    console.log(chalk.bold('  Share this command with your team:'));
    console.log('');
    console.log(chalk.cyan(`    npx agentlytics --join ${localIp}:${RELAY_PORT} --username <name>`));
    console.log('');
    console.log(chalk.bold('  MCP server endpoint (add to your AI client):'));
    console.log('');
    console.log(chalk.cyan(`    ${relayUrl}/mcp`));
    console.log('');
    console.log(chalk.dim('  REST endpoints:'));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/health`));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/users`));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/search?q=<query>`));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/activity/<username>`));
    console.log(chalk.dim(`    GET  ${relayUrl}/relay/session/<chatId>`));
    console.log('');
    console.log(chalk.dim('  Press Ctrl+C to stop'));
    console.log('');
  });

  // Skip the rest of the normal flow
  return;
}

// ── Join mode ────────────────────────────────────────────────
if (isJoin) {
  const relayAddress = process.argv[joinIndex + 1];
  const usernameIndex = process.argv.indexOf('--username');
  const username = usernameIndex !== -1 ? process.argv[usernameIndex + 1] : null;

  if (!relayAddress) {
    console.error(chalk.red('\n  ✗ Missing relay address. Usage: npx agentlytics --join <host:port> --username <name>\n'));
    process.exit(1);
  }
  if (!username) {
    console.error(chalk.red('\n  ✗ Missing username. Usage: npx agentlytics --join <host:port> --username <name>\n'));
    process.exit(1);
  }

  const { startJoinClient } = require('./relay-client');
  startJoinClient(relayAddress, username);

  // Skip the rest of the normal flow
  return;
}

// ── Helper: get local IP for relay ───────────────────────────
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

console.log('');
console.log(chalk.bold('  ⚡ Agentlytics'));
console.log(chalk.dim('  Comprehensive analytics for your AI coding agents'));
if (collectOnly) console.log(chalk.cyan('  ⟳ Collect-only mode (no server)'));
console.log('');

// ── Build UI if not already built ──────────────────────────
const publicIndex = path.join(__dirname, 'public', 'index.html');
const uiDir = path.join(__dirname, 'ui');

if (!collectOnly && !fs.existsSync(publicIndex) && fs.existsSync(uiDir)) {
  console.log(chalk.cyan('  ⟳ Building dashboard UI (first run)...'));
  try {
    const uiModules = path.join(uiDir, 'node_modules');
    if (!fs.existsSync(uiModules)) {
      console.log(chalk.dim('    Installing UI dependencies...'));
      execSync('npm install --no-audit --no-fund', { cwd: uiDir, stdio: 'pipe' });
    }
    console.log(chalk.dim('    Compiling frontend...'));
    execSync('npm run build', { cwd: uiDir, stdio: 'pipe' });
    console.log(chalk.green('  ✓ UI built successfully'));
  } catch (err) {
    console.error(chalk.red('  ✗ UI build failed:'), err.message);
    process.exit(1);
  }
  console.log('');
}

if (!collectOnly && !fs.existsSync(publicIndex)) {
  console.error(chalk.red('  ✗ No built UI found at public/index.html'));
  console.error(chalk.dim('    Run: cd ui && npm install && npm run build'));
  process.exit(1);
}

const cache = require('./cache');

// Wipe cache if --no-cache flag is passed
if (noCache) {
  const cacheDb = path.join(os.homedir(), '.agentlytics', 'cache.db');
  if (fs.existsSync(cacheDb)) {
    fs.unlinkSync(cacheDb);
    console.log(chalk.yellow('  ⟳ Cache cleared (--no-cache)'));
  }
}

// ── Warn about installed-but-not-running Windsurf variants ─
const WINDSURF_VARIANTS = [
  { name: 'Windsurf', app: '/Applications/Windsurf.app', dataDir: path.join(HOME, '.codeium', 'windsurf'), ide: 'windsurf' },
  { name: 'Windsurf Next', app: '/Applications/Windsurf Next.app', dataDir: path.join(HOME, '.codeium', 'windsurf-next'), ide: 'windsurf-next' },
  { name: 'Antigravity', app: '/Applications/Antigravity.app', dataDir: path.join(HOME, '.codeium', 'antigravity'), ide: 'antigravity' },
];

(() => {
  // Check which language servers are running
  let runningIdes = [];
  try {
    const ps = execSync('ps aux', { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    for (const line of ps.split('\n')) {
      if (!line.includes('language_server_macos') || !line.includes('--csrf_token')) continue;
      const ideMatch = line.match(/--ide_name\s+(\S+)/);
      const appDirMatch = line.match(/--app_data_dir\s+(\S+)/);
      if (ideMatch) runningIdes.push(ideMatch[1]);
      if (appDirMatch) runningIdes.push(appDirMatch[1]);
    }
  } catch {}

  const installedNotRunning = WINDSURF_VARIANTS.filter(v => {
    const installed = fs.existsSync(v.app) || fs.existsSync(v.dataDir);
    const running = runningIdes.some(r => r === v.ide || r.includes(v.ide));
    return installed && !running;
  });

  if (installedNotRunning.length > 0) {
    const names = installedNotRunning.map(v => chalk.bold(v.name)).join(', ');
    console.log(chalk.yellow(`  ⚠ ${names} installed but not running`));
    console.log(chalk.dim('    These editors must be open for their sessions to be detected.'));
    console.log('');
  }
})();

// Initialize cache DB
console.log(chalk.dim('  Initializing cache database...'));
cache.initDb();

// Scan all editors and populate cache
console.log(chalk.dim('  Scanning editors: Cursor, Windsurf, Claude Code, VS Code, Zed, Antigravity, OpenCode, Codex, Gemini CLI, Copilot CLI, Cursor Agent, Command Code'));
const startTime = Date.now();
const result = cache.scanAll((progress) => {
  process.stdout.write(chalk.dim(`\r  Scanning: ${progress.scanned}/${progress.total} chats (${progress.analyzed} analyzed, ${progress.skipped} cached)`));
});
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log('');
console.log(chalk.green(`  ✓ Cache ready: ${result.total} chats, ${result.analyzed} analyzed, ${result.skipped} cached (${elapsed}s)`));
console.log('');

// In collect-only mode, exit after cache is built
if (collectOnly) {
  const cacheDbPath = path.join(os.homedir(), '.agentlytics', 'cache.db');
  console.log(chalk.dim(`  Cache file: ${cacheDbPath}`));
  console.log('');
  process.exit(0);
}

// Start server
const app = require('./server');
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(chalk.green(`  ✓ Dashboard ready at ${chalk.bold.white(url)}`));
  console.log(chalk.dim(`  Press Ctrl+C to stop\n`));

  // Auto-open browser
  const open = require('open');
  open(url).catch(() => {});
});
