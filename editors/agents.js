const path = require('path');
const os = require('os');

const name = 'agents';
const labels = { 'agents': 'Agents' };

function getChats() {
  return [];
}

function getMessages() {
  return [];
}

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'agents',
    label: 'Agents',
    files: [],
    dirs: ['.agents/skills'],
  });
}

function getGlobalArtifacts() {
  const { scanArtifacts } = require('./base');
  const artifacts = scanArtifacts(path.join(os.homedir(), '.agents'), {
    editor: 'agents',
    label: 'Agents',
    files: [],
    dirs: ['skills'],
  });
  for (const a of artifacts) a.scope = 'global';
  return artifacts;
}

module.exports = { name, labels, getChats, getMessages, getArtifacts, getGlobalArtifacts };
