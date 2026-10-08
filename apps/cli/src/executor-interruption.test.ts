import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runMeteredAgent } from './agent-usage.js'
import { randomUUID } from 'node:crypto'
import { reviewRequirementBranch } from './daemon-review.js'
import { ExecutorResourceBlocked, failureObservation } from './executor-availability.js'

const scope = { daemonId: randomUUID(), projectId: randomUUID(), requirementId: randomUUID(), runId: randomUUID(), leaseGeneration: 1, workerIndex: 0, agent: 'codex', phase: 'execution' as const }
test('exit-zero resource errors and long-lived blocked processes use the same interruption result',async()=>{
  for (const wait of [false,true]) {
    const observations:any[]=[]
    const script=`process.stdout.write('{"type":"error","error":{"code":"insuff');setTimeout(()=>{process.stdout.write('icient_quota"}}');${wait ? 'setInterval(()=>{},1000)' : ''}},20)`
    const result=await runMeteredAgent(process.execPath,['-e',script],{timeoutMs:2000,killGraceMs:50},scope,async()=>{}, {profileId:'fixture',onObservation:async o=>{observations.push(o)}})
    assert.equal(result.ok,false);assert.equal(result.resourceInterruption?.failure,'quota_exhausted');assert.equal(result.timedOut,false);assert.equal(result.cancelled,false);assert.equal(observations.length,1)
  }
})
test('review resource interruptions do not create findings, followups or approval decisions',async()=>{
  let followups=0,decisions=0
  await assert.rejects(reviewRequirementBranch({ requirement:{id:scope.requirementId,title:'Fixture',projectId:scope.projectId},branchName:'fixture',worktreePath:'/tmp/fixture',commentTaskId:null,
    run:(_command,args)=>({ok:true,status:0,stdout:args.includes('rev-parse')?'abc123':'',stderr:'',command:'git'}),runAiReview:async()=>{throw new ExecutorResourceBlocked(failureObservation('codex','fixture','quota_exhausted','structured_error'))},
    createFollowupTask:async()=>{followups++},onAiDecision:async()=>{decisions++},
  }),ExecutorResourceBlocked)
  assert.equal(followups,0);assert.equal(decisions,0)
})
