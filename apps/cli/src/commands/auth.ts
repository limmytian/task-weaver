import { Command } from 'commander'
import * as readline from 'readline/promises'
import { loadConfig, saveConfig, configFilePath } from '../config.js'
import { get } from '../client.js'

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('manage CLI authentication')

  auth
    .command('setup')
    .description('configure API URL and API key')
    .action(async () => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const current = loadConfig()

      const apiUrl = await rl.question(`API URL [${current.apiUrl}]: `)
      const apiKey = await rl.question(`API key (leave blank to clear): `)
      rl.close()

      const config = {
        apiUrl: apiUrl.trim() || current.apiUrl,
        apiKey: apiKey.trim() || undefined,
      }
      saveConfig(config)
      console.log(`Saved to ${configFilePath()}`)
    })

  auth
    .command('status')
    .description('show current auth configuration')
    .action(async () => {
      const config = loadConfig()
      console.log(`API URL:  ${config.apiUrl}`)
      console.log(`API Key:  ${config.apiKey ? config.apiKey.slice(0, 8) + '…' : '(not set)'}`)
      console.log(`Config:   ${configFilePath()}`)
      console.log()
      try {
        await get('/health')
        console.log('Connection: OK')
      } catch {
        console.log('Connection: FAILED (check API URL and key)')
      }
    })
}
