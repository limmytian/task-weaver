import { Command } from 'commander'
import { post } from '../client.js'
import { printJson } from '../output.js'

export function registerExecution(program: Command) {
  const git = program.command('execution').description('inspect and synchronize the current delegated execution').command('git').description('request scoped daemon Git operations; local merge/rebase remains agent-led')
  for (const operation of ['fetch', 'verify']) {
    git.command(`${operation} <repository-id>`).description(operation === 'fetch' ? 'fetch and inspect the latest target branch' : 'fresh fetch, verify target ancestry and record the execution baseline')
      .option('--json', 'output JSON').action(async (repositoryId: string) => { printJson(await post('/api/v1/execution/git', { operation, repositoryId })) })
  }
}
