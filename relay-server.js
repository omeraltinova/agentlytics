const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const CACHE_DIR = path.join(os.homedir(), '.agentlytics');
const RELAY_DB_PATH = path.join(CACHE_DIR, 'relay.db');

let db = null;

// ============================================================
// Schema
// ============================================================

function initRelayDb() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  db = new Database(RELAY_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      last_seen INTEGER,
      projects TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS relay_chats (
      id TEXT NOT NULL,
      username TEXT NOT NULL,
      source TEXT,
      name TEXT,
      mode TEXT,
      folder TEXT,
      created_at INTEGER,
      last_updated_at INTEGER,
      bubble_count INTEGER DEFAULT 0,
      PRIMARY KEY (id, username)
    );

    CREATE TABLE IF NOT EXISTS relay_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      username TEXT NOT NULL,
      seq INTEGER,
      role TEXT,
      content TEXT,
      model TEXT
    );

    CREATE TABLE IF NOT EXISTS relay_chat_stats (
      chat_id TEXT NOT NULL,
      username TEXT NOT NULL,
      total_messages INTEGER DEFAULT 0,
      user_messages INTEGER DEFAULT 0,
      assistant_messages INTEGER DEFAULT 0,
      tool_calls TEXT DEFAULT '[]',
      models TEXT DEFAULT '[]',
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (chat_id, username)
    );

    CREATE INDEX IF NOT EXISTS idx_relay_chats_username ON relay_chats(username);
    CREATE INDEX IF NOT EXISTS idx_relay_chats_folder ON relay_chats(folder);
    CREATE INDEX IF NOT EXISTS idx_relay_messages_chat ON relay_messages(chat_id, username);
    CREATE INDEX IF NOT EXISTS idx_relay_messages_content ON relay_messages(content);
  `);

  return db;
}

function getRelayDb() {
  return db;
}

// ============================================================
// Express app
// ============================================================

function createRelayApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // ── Health check ──
  app.get('/relay/health', (req, res) => {
    res.json({ ok: true, users: db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt });
  });

  // ── List connected users ──
  app.get('/relay/users', (req, res) => {
    try {
      const users = db.prepare('SELECT username, last_seen, projects FROM users ORDER BY last_seen DESC').all();
      res.json(users.map(u => ({
        username: u.username,
        lastSeen: u.last_seen,
        projects: JSON.parse(u.projects || '[]'),
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sync endpoint — receives data from join clients ──
  app.post('/relay/sync', (req, res) => {
    try {
      const { username, projects, chats, messages, stats } = req.body;
      if (!username) return res.status(400).json({ error: 'username required' });

      // Upsert user
      db.prepare(`
        INSERT INTO users (username, last_seen, projects)
        VALUES (?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET last_seen = excluded.last_seen, projects = excluded.projects
      `).run(username, Date.now(), JSON.stringify(projects || []));

      let syncedChats = 0;
      let syncedMessages = 0;
      let syncedStats = 0;

      // Upsert chats
      if (chats && chats.length > 0) {
        const insChat = db.prepare(`
          INSERT INTO relay_chats (id, username, source, name, mode, folder, created_at, last_updated_at, bubble_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id, username) DO UPDATE SET
            name = excluded.name, mode = excluded.mode, folder = excluded.folder,
            last_updated_at = excluded.last_updated_at, bubble_count = excluded.bubble_count
        `);
        const insertChats = db.transaction((chatList) => {
          for (const c of chatList) {
            insChat.run(c.id, username, c.source, c.name, c.mode, c.folder, c.created_at, c.last_updated_at, c.bubble_count || 0);
            syncedChats++;
          }
        });
        insertChats(chats);
      }

      // Upsert messages (delete + reinsert per chat)
      if (messages && messages.length > 0) {
        const chatIds = [...new Set(messages.map(m => m.chat_id))];
        const delMsgs = db.prepare('DELETE FROM relay_messages WHERE chat_id = ? AND username = ?');
        const insMsg = db.prepare('INSERT INTO relay_messages (chat_id, username, seq, role, content, model) VALUES (?, ?, ?, ?, ?, ?)');
        const insertMessages = db.transaction((msgList) => {
          for (const cid of chatIds) {
            delMsgs.run(cid, username);
          }
          for (const m of msgList) {
            insMsg.run(m.chat_id, username, m.seq, m.role, m.content, m.model);
            syncedMessages++;
          }
        });
        insertMessages(messages);
      }

      // Upsert stats
      if (stats && stats.length > 0) {
        const insStat = db.prepare(`
          INSERT INTO relay_chat_stats (chat_id, username, total_messages, user_messages, assistant_messages, tool_calls, models, total_input_tokens, total_output_tokens)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chat_id, username) DO UPDATE SET
            total_messages = excluded.total_messages, user_messages = excluded.user_messages,
            assistant_messages = excluded.assistant_messages, tool_calls = excluded.tool_calls,
            models = excluded.models, total_input_tokens = excluded.total_input_tokens,
            total_output_tokens = excluded.total_output_tokens
        `);
        const insertStats = db.transaction((statList) => {
          for (const s of statList) {
            insStat.run(s.chat_id, username, s.total_messages, s.user_messages, s.assistant_messages,
              JSON.stringify(s.tool_calls || []), JSON.stringify(s.models || []),
              s.total_input_tokens, s.total_output_tokens);
            syncedStats++;
          }
        });
        insertStats(stats);
      }

      res.json({ ok: true, synced: { chats: syncedChats, messages: syncedMessages, stats: syncedStats } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Search messages across all users ──
  app.get('/relay/search', (req, res) => {
    try {
      const { q, username, folder, limit } = req.query;
      if (!q) return res.status(400).json({ error: 'q (query) required' });

      let sql = `
        SELECT rm.chat_id, rm.username, rm.role, rm.content, rm.model, rm.seq,
               rc.name as chat_name, rc.source, rc.folder
        FROM relay_messages rm
        JOIN relay_chats rc ON rm.chat_id = rc.id AND rm.username = rc.username
        WHERE rm.content LIKE ?`;
      const params = [`%${q}%`];

      if (username) { sql += ' AND rm.username = ?'; params.push(username); }
      if (folder) { sql += ' AND rc.folder LIKE ?'; params.push(`%${folder}%`); }
      sql += ' ORDER BY rc.last_updated_at DESC LIMIT ?';
      params.push(parseInt(limit) || 50);

      const rows = db.prepare(sql).all(...params);
      res.json(rows.map(r => ({
        chatId: r.chat_id,
        username: r.username,
        role: r.role,
        content: r.content.length > 500 ? r.content.substring(0, 500) + '...' : r.content,
        model: r.model,
        seq: r.seq,
        chatName: r.chat_name,
        source: r.source,
        folder: r.folder,
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Get user activity ──
  app.get('/relay/activity/:username', (req, res) => {
    try {
      const { username } = req.params;
      const { folder, limit } = req.query;

      let sql = `
        SELECT rc.*, rcs.total_messages, rcs.models, rcs.tool_calls,
               rcs.total_input_tokens, rcs.total_output_tokens
        FROM relay_chats rc
        LEFT JOIN relay_chat_stats rcs ON rc.id = rcs.chat_id AND rc.username = rcs.username
        WHERE rc.username = ?`;
      const params = [username];

      if (folder) { sql += ' AND rc.folder LIKE ?'; params.push(`%${folder}%`); }
      sql += ' ORDER BY rc.last_updated_at DESC LIMIT ?';
      params.push(parseInt(limit) || 50);

      const rows = db.prepare(sql).all(...params);
      res.json(rows.map(r => ({
        id: r.id,
        username: r.username,
        source: r.source,
        name: r.name,
        mode: r.mode,
        folder: r.folder,
        createdAt: r.created_at,
        lastUpdatedAt: r.last_updated_at,
        totalMessages: r.total_messages,
        models: r.models ? JSON.parse(r.models) : [],
        toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : [],
        totalInputTokens: r.total_input_tokens,
        totalOutputTokens: r.total_output_tokens,
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Get session detail ──
  app.get('/relay/session/:chatId', (req, res) => {
    try {
      const { chatId } = req.params;
      const { username } = req.query;

      let chatSql = 'SELECT * FROM relay_chats WHERE id = ?';
      const chatParams = [chatId];
      if (username) { chatSql += ' AND username = ?'; chatParams.push(username); }
      chatSql += ' LIMIT 1';

      const chat = db.prepare(chatSql).get(...chatParams);
      if (!chat) return res.status(404).json({ error: 'Session not found' });

      const messages = db.prepare(
        'SELECT seq, role, content, model FROM relay_messages WHERE chat_id = ? AND username = ? ORDER BY seq'
      ).all(chat.id, chat.username);

      const stats = db.prepare(
        'SELECT * FROM relay_chat_stats WHERE chat_id = ? AND username = ?'
      ).get(chat.id, chat.username);

      res.json({
        id: chat.id,
        username: chat.username,
        source: chat.source,
        name: chat.name,
        mode: chat.mode,
        folder: chat.folder,
        createdAt: chat.created_at,
        lastUpdatedAt: chat.last_updated_at,
        messages,
        stats: stats ? {
          totalMessages: stats.total_messages,
          models: JSON.parse(stats.models || '[]'),
          toolCalls: JSON.parse(stats.tool_calls || '[]'),
          totalInputTokens: stats.total_input_tokens,
          totalOutputTokens: stats.total_output_tokens,
        } : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { initRelayDb, getRelayDb, createRelayApp };
