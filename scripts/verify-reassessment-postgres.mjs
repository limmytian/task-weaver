import { execFileSync, spawnSync } from 'node:child_process';
const name = 'tw-reassessment-' + process.pid;
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8'}).trim();
docker('run','--rm','-d','--name',name,'-e','POSTGRES_DB=tw_reassessment_e2e','-e','POSTGRES_USER=fixture','-e','POSTGRES_PASSWORD=fixture-only','-p','127.0.0.1::5432','pgvector/pgvector:0.8.6-pg16-bookworm');
try {
 for(let i=0;i<100;i++){if(spawnSync('docker',['exec',name,'pg_isready','-U','fixture']).status===0)break; await new Promise(r=>setTimeout(r,200));}
 const port=JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
 const r=spawnSync('pnpm',['--filter','@task-weaver/api','exec','tsx','--test','src/reassessment.postgres-e2e.test.ts'],{stdio:'inherit',env:{...process.env,TW_REASSESSMENT_E2E_DATABASE_URL:`postgres://fixture:fixture-only@127.0.0.1:${port}/tw_reassessment_e2e`},timeout:120000}); process.exitCode=r.status??1;
} finally {docker('rm','-f',name)}
