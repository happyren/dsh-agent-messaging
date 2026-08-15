#!/usr/bin/env node
/**
 * The package's command line: two commands, both for the operator rather than
 * the model.
 *
 *   npx dsh-agent-messaging doctor   — can this plugin work here, and if not, why
 *   npx dsh-agent-messaging report   — what did collaboration cost, and catch
 *
 * Kept out of the tool surface on purpose. The audience is whoever is deciding
 * whether the plugin earns its turns; putting either in front of a model would
 * take attention from the tools that do the work.
 */

const [command, ...rest] = process.argv.slice(2)

const COMMANDS = {
  doctor: './doctor.mjs',
  report: './report.mjs',
}

if (command === undefined || command === '--help' || command === '-h') {
  console.log(
    [
      'dsh-agent-messaging — cross-session agent-to-agent messaging for DeepSeek Harness',
      '',
      'Usage:',
      '  npx dsh-agent-messaging doctor [--state-root PATH] [--json]',
      '  npx dsh-agent-messaging report [--days N] [--state-root PATH]',
      '',
      'doctor exits non-zero when something would stop messaging working.',
    ].join('\n'),
  )
  process.exit(0)
}

const target = COMMANDS[command]
if (target === undefined) {
  console.error(`unknown command "${command}". Try: ${Object.keys(COMMANDS).join(', ')}`)
  process.exit(2)
}

// The subcommands parse their own flags off argv, so hand them a clean one.
process.argv = [process.argv[0], process.argv[1], ...rest]
await import(target)
