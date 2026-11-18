// Keep the host entry's metadata separate from the host modules. The DSH loader
// can activate this lightweight entry before importing the full Bot runtime.
export const name = 'ds-bot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']
