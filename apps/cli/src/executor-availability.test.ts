import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyExecutorLine, ExecutorSignalCollector, parseCodexQuota, queryCodexQuota } from './executor-availability.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('provider errors are classified without treating discussion, tool errors, exit codes or 429 as quota',()=>{
  for(const line of ['HTTP 429','quota exhausted','The code handles rate_limit_error','{"type":"item.completed","item":{"text":"insufficient_quota"}}','{"type":"tool_call","error":{"code":"insufficient_quota"}}'])
    assert.equal(classifyExecutorLine('codex',line,'stdout'),null)
  for(const [code,failure] of [['rate_limit_error','rate_limited'],['insufficient_quota','quota_exhausted'],['billing_error','billing_blocked'],['invalid_api_key','auth_required']])
    assert.equal(classifyExecutorLine('claude',JSON.stringify({type:'error',error:{type:code}}),'stdout')?.failure,failure)
  assert.equal(classifyExecutorLine('codex',JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit. Try again later."}}),'stdout')?.failure,'quota_exhausted')
})
test('fragmented output is bounded, streams isolated, and diagnostics sanitized',()=>{
  const collector=new ExecutorSignalCollector('codex','local')
  collector.push('stdout',Buffer.from('x'.repeat(70000)+'\n'))
  collector.push('stdout',Buffer.from('{"type":"error","error":{"code":"insuff'))
  collector.push('stderr',Buffer.from('HTTP 429\n'))
  collector.push('stdout',Buffer.from('icient_quota","message":"secret-value"}}\n'))
  assert.equal(collector.finish()?.failure,'quota_exhausted')
  assert.equal(JSON.stringify(collector.observation).includes('secret-value'),false)
})
test('multi-bucket windows preserve unknown and past resets do not prove exhaustion',()=>{
  const now=new Date('2026-10-08T12:00:00Z')
  const observation=parseCodexQuota({rateLimitsByLimitId:{codex:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:now.getTime()/1000+100},secondary:{usedPercent:100,windowDurationMins:10080,resetsAt:now.getTime()/1000+200}},other:{primary:{usedPercent:50}}}},'local',now)
  assert.equal(observation.state,'cooling_down');assert.equal(observation.windows.length,3)
  assert.equal(observation.windows[0]!.remainingPercent,75)
  assert.equal(parseCodexQuota({rateLimits:{primary:{usedPercent:100,resetsAt:1}}},'local',now).state,'unknown')
  assert.equal(parseCodexQuota({},'local',now).state,'unknown')
})
test('quota query uses only initialization and read-only status, handles unsupported and bounded hangs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tw-quota-'))
  const file=join(dir,'codex')
  writeFileSync(file,`#!/usr/bin/env node
const readline=require('node:readline'); readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.method==='initialize')console.log(JSON.stringify({id:1,result:{}}));else if(x.method==='account/rateLimits/read')console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}}}));else if(x.method!=='initialized')process.exit(2);});`,{mode:0o700})
  try {assert.equal((await queryCodexQuota('local',process.env,file,1000)).state,'available')
    writeFileSync(file,'#!/usr/bin/env node\nsetInterval(()=>{},1000)',{mode:0o700})
    assert.equal((await queryCodexQuota('local',process.env,file,100)).state,'unknown')
  }finally {rmSync(dir,{recursive:true,force:true})}
})
