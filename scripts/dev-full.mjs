import { spawn } from 'node:child_process'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const usesProcessGroups = process.platform !== 'win32'
const processes = [
  spawn(npmCommand, ['run', 'dev:web'], {
    stdio: 'inherit',
    detached: usesProcessGroups,
  }),
  spawn(npmCommand, ['run', 'dev:api'], {
    stdio: 'inherit',
    detached: usesProcessGroups,
  }),
]

let finishing = false

function finish(exitCode = 0) {
  if (finishing) return
  finishing = true

  for (const child of processes) {
    if (child.killed || !child.pid) continue

    try {
      if (usesProcessGroups) {
        process.kill(-child.pid, 'SIGTERM')
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // O processo pode já ter sido encerrado pelo sistema.
    }
  }

  process.exitCode = exitCode
}

for (const child of processes) {
  child.on('error', () => finish(1))
  child.on('exit', (code, signal) => {
    if (!finishing && (code !== 0 || signal)) {
      finish(code ?? 1)
    }
  })
}

process.on('SIGINT', () => finish())
process.on('SIGTERM', () => finish())
