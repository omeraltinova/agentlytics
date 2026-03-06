#!/usr/bin/env node

const { program } = require('commander');
const chalk = require('chalk');
const fs = require('fs');

const { getAllChats, getMessages, findChat } = require('./editors');
const { extractText, roleColor, roleLabel, formatDate, truncate, shortenPath } = require('./editors/base');

// ============================================================
// Commands
// ============================================================

function sourceTag(source) {
  if (source === 'cursor') return chalk.yellow('cursor');
  if (source === 'windsurf') return chalk.cyan('windsurf');
  if (source === 'windsurf-next') return chalk.cyan('ws-next');
  return chalk.dim(source);
}

function modeTag(chat) {
  const mode = chat.mode || '';
  if (mode === 'agent') return chalk.magenta('agent');
  if (mode === 'chat') return chalk.blue('chat');
  if (mode === 'cascade') return chalk.cyan('cascade');
  if (mode === 'edit') return chalk.green('edit');
  return chalk.dim(mode || '—');
}

function listChats(opts) {
  const chats = getAllChats();
  const folderFilter = opts.folder;
  const editorFilter = opts.editor;

  let filtered = chats;
  if (folderFilter) {
    const f = folderFilter.toLowerCase();
    filtered = filtered.filter((c) => c.folder && c.folder.toLowerCase().includes(f));
  }
  if (editorFilter) {
    const e = editorFilter.toLowerCase();
    filtered = filtered.filter((c) => c.source && c.source.toLowerCase().includes(e));
  }

  // Only show chats that have names or bubbles (unless --all)
  if (!opts.all) {
    filtered = filtered.filter((c) => c.name || (c.bubbleCount && c.bubbleCount > 0));
  }

  const limit = opts.limit ? parseInt(opts.limit) : filtered.length;
  const display = filtered.slice(0, limit);

  console.log(chalk.bold(`\n📋 AI Chats (${filtered.length} found, ${chats.length} total)\n`));
  console.log(chalk.gray('─'.repeat(120)));

  for (const chat of display) {
    const date = formatDate(chat.lastUpdatedAt || chat.createdAt);
    const name = (chat.name || '(untitled)').substring(0, 32);
    const folder = shortenPath(chat.folder, 28);
    const encrypted = chat.encrypted ? chalk.dim(' 🔒') : '';

    console.log(
      `  ${sourceTag(chat.source).padEnd(18)} ${modeTag(chat).padEnd(18)} ${chalk.bold.white(name.padEnd(33))}${encrypted} ${chalk.gray(date.padEnd(25))} ${chalk.dim(folder.padEnd(30))} ${chalk.dim(chat.composerId.substring(0, 8))}`
    );
  }

  console.log(chalk.gray('─'.repeat(120)));
  console.log(chalk.dim(`\nUse ${chalk.white('view <id-prefix>')} to view a conversation.`));
  console.log(chalk.dim(`Use ${chalk.white('--editor cursor|windsurf|claude')} to filter by editor. Use ${chalk.white('--folder <path>')} to filter by project.\n`));
}

function viewChat(chatIdPrefix, opts) {
  const chat = findChat(chatIdPrefix);
  if (!chat) {
    console.log(chalk.red(`No chat found matching "${chatIdPrefix}"`));
    return;
  }

  if (chat.encrypted) {
    console.log(chalk.bold(`\n💬 ${chat.name || '(untitled)'}`));
    console.log(chalk.gray(`   Created: ${formatDate(chat.createdAt)}`));
    if (chat.folder) console.log(chalk.gray(`   Project: ${chat.folder}`));
    console.log(chalk.gray(`   ID:      ${chat.composerId}`));
    console.log(chalk.gray(`   Source:  ${chat.source}`));
    console.log(chalk.gray('─'.repeat(80)) + '\n');
    console.log(chalk.yellow('🔒 This conversation is stored encrypted and cannot be read.'));
    console.log(chalk.dim('   Windsurf stores Cascade sessions in encrypted .pb files.\n'));
    return;
  }

  const messages = getMessages(chat);
  const showSystem = opts.system || false;
  const showTools = opts.tools || false;
  const showReasoning = opts.reasoning || false;

  console.log(chalk.bold(`\n💬 ${chat.name || '(untitled)'}`));
  console.log(chalk.gray(`   Created: ${formatDate(chat.createdAt)}`));
  if (chat.folder) console.log(chalk.gray(`   Project: ${chat.folder}`));
  console.log(chalk.gray(`   ID:      ${chat.composerId}`));
  console.log(chalk.gray(`   Source:  ${chat.source}`));
  console.log(chalk.gray('─'.repeat(80)) + '\n');

  let count = 0;
  for (const msg of messages) {
    if (msg.role === 'system' && !showSystem) continue;
    if (msg.role === 'tool' && !showTools) continue;

    const rich = showTools || msg.role === 'assistant' || msg.role === 'tool';
    const text = extractText(msg.content, { richToolDisplay: rich });
    if (!text.trim()) continue;

    const lines = text.split('\n');
    const filteredLines = showReasoning
      ? lines
      : lines.filter((l) => !l.startsWith('[thinking]'));

    const display = filteredLines.join('\n').trim();
    if (!display) continue;

    const color = roleColor(msg.role);
    console.log(color(chalk.bold(roleLabel(msg.role))));
    if (rich && (msg.role === 'assistant' || msg.role === 'tool')) {
      console.log(display);
    } else {
      console.log(color(display));
    }
    console.log('');
    count++;
  }

  console.log(chalk.gray('─'.repeat(80)));
  console.log(chalk.dim(`${count} messages displayed (${messages.length} total)\n`));
}

function exportChat(chatIdPrefix, opts) {
  const chat = findChat(chatIdPrefix);
  if (!chat) {
    console.log(chalk.red(`No chat found matching "${chatIdPrefix}"`));
    return;
  }

  if (chat.encrypted) {
    console.log(chalk.yellow('🔒 Cannot export encrypted conversation.'));
    return;
  }

  const messages = getMessages(chat);
  const includeSystem = opts.system || false;
  const includeTools = opts.tools || false;

  let md = `# ${chat.name || '(untitled)'}\n\n`;
  md += `- **Created**: ${formatDate(chat.createdAt)}\n`;
  md += `- **Source**: ${chat.source}\n`;
  if (chat.folder) md += `- **Project**: ${chat.folder}\n`;
  md += `- **Chat ID**: ${chat.composerId}\n\n---\n\n`;

  for (const msg of messages) {
    if (msg.role === 'system' && !includeSystem) continue;
    if (msg.role === 'tool' && !includeTools) continue;

    const text = extractText(msg.content);
    if (!text.trim()) continue;

    const label = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    md += `## ${label}\n\n${text}\n\n---\n\n`;
  }

  const outFile = opts.output || `chat-${chat.composerId.substring(0, 8)}.md`;
  fs.writeFileSync(outFile, md, 'utf-8');
  console.log(chalk.green(`Exported to ${outFile}`));
}

function searchChats(query, opts) {
  const chats = getAllChats();
  const queryLower = query.toLowerCase();
  const editorFilter = opts.editor;
  const results = [];

  for (const chat of chats) {
    if (editorFilter && !chat.source.toLowerCase().includes(editorFilter.toLowerCase())) continue;

    // Search in name
    if (chat.name && chat.name.toLowerCase().includes(queryLower)) {
      results.push({ ...chat, matchType: 'name', snippet: chat.name });
      continue;
    }

    // Search in folder
    if (chat.folder && chat.folder.toLowerCase().includes(queryLower)) {
      results.push({ ...chat, matchType: 'folder', snippet: chat.folder });
      continue;
    }

    // Search in message content (opt-in with --deep, skip encrypted)
    if (opts.deep && !chat.encrypted) {
      try {
        const messages = getMessages(chat);
        for (const msg of messages) {
          const text = extractText(msg.content);
          if (text.toLowerCase().includes(queryLower)) {
            results.push({
              ...chat,
              matchType: msg.role,
              snippet: truncate(text, 100),
            });
            break;
          }
        }
      } catch { /* skip */ }
    }
  }

  if (results.length === 0) {
    console.log(chalk.yellow(`No results for "${query}".`));
    if (!opts.deep) console.log(chalk.dim('Use --deep to also search message content.'));
    return;
  }

  console.log(chalk.bold(`\n🔍 Search results for "${query}" (${results.length} matches)\n`));
  for (const r of results) {
    const name = r.name || '(untitled)';
    const folder = r.folder ? chalk.dim(` ${shortenPath(r.folder, 40)}`) : '';
    const src = sourceTag(r.source);
    console.log(`  ${src} ${chalk.bold.white(name)}${folder} ${chalk.gray(formatDate(r.lastUpdatedAt || r.createdAt))}`);
    console.log(`  ${chalk.dim(r.composerId.substring(0, 8))} ${chalk.dim(`[${r.matchType}]`)}`);
    if (r.snippet && r.matchType !== 'name') console.log(`  ${chalk.italic(truncate(r.snippet, 100))}`);
    console.log('');
  }
}

// ============================================================
// CLI
// ============================================================

program
  .name('ai-chat-cli')
  .description('CLI tool to browse and export AI IDE chat history (Cursor, Windsurf)')
  .version('1.0.0');

program
  .command('list')
  .description('List all chats across all supported editors')
  .option('-l, --limit <n>', 'Limit number of results')
  .option('-f, --folder <path>', 'Filter by project folder path')
  .option('-e, --editor <name>', 'Filter by editor (cursor, windsurf, claude)')
  .option('-a, --all', 'Include empty/unnamed chats')
  .action(listChats);

program
  .command('view <chat-id>')
  .description('View a conversation (use ID or prefix)')
  .option('-s, --system', 'Show system messages')
  .option('-t, --tools', 'Show tool call/result messages')
  .option('-r, --reasoning', 'Show reasoning/thinking blocks')
  .action(viewChat);

program
  .command('export <chat-id>')
  .description('Export a conversation to Markdown')
  .option('-o, --output <file>', 'Output file path')
  .option('-s, --system', 'Include system messages')
  .option('-t, --tools', 'Include tool messages')
  .action(exportChat);

program
  .command('search <query>')
  .description('Search chats by name, folder, or content')
  .option('-d, --deep', 'Also search message content (slower)')
  .option('-e, --editor <name>', 'Filter by editor (cursor, windsurf, claude)')
  .action(searchChats);

program.parse();
