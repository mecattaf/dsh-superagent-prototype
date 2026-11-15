import {writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {workflowHost,newDirectory,type WorkflowHost} from './fixtures/workflow.ts'
const hosts:WorkflowHost[]=[],dirs:string[]=[]
afterEach(async()=>{for(const h of hosts.splice(0))await h.stop();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
const until=async(f:()=>unknown)=>vi.waitFor(()=>expect(f()).toBeTruthy(),{timeout:3000,interval:5})
async function start(body:string,directory=newDirectory()){
 if(!dirs.includes(directory))dirs.push(directory)
 const h=workflowHost(directory);hosts.push(h);await h.started
 const script=join(directory,'terminal.workflow.js');writeFileSync(script,`export const meta={name:'terminal',description:'literal test'};\n${body}`)
 return{h,directory,id:h.floor.startRun({script,cwd:directory}).run_id}
}
describe('actionable workflow terminal failure relay',()=>{
 it('commits one stable run-ID relay with terminal failure, without raw error or task content',async()=>{
  const {h,id}=await start("throw new Error('PRIVATE PAPER OR TOKEN MUST NEVER BE RELAYED');")
  await until(()=>h.run(id)?.state==='failed')
  expect(h.run(id)?.failureRelayQueued).toBe(true);expect(h.failureRelays).toHaveBeenCalledTimes(1)
  const [key,text]=h.failureRelays.mock.calls[0]!
  expect(key).toBe(`workflow-terminal-failure:${id}`)
  expect(JSON.parse(text)).toMatchObject({kind:'workflow-terminal-failure',run_id:id,error_code:'workflow-failed',last_node:null})
  expect(text).not.toContain('PRIVATE');expect(text.length).toBeLessThan(1600)
  expect(h.effects.pending('relay',key)).toBe(true)
  expect(h.floor.status(id)[0]?.state).toBe('failed')
 })
 it('does not re-enqueue on restart/replay and leaves a failed delivery durable',async()=>{
  const {h:first,id,directory}=await start("throw new Error('literal');")
  await until(()=>first.run(id)?.state==='failed')
  first.effects.handle('relay',async()=>{throw Error('temporary transport')},{retry:[60000,60000]})
  first.effects.start();await first.effects.idle('relay')
  expect(first.effects.pending('relay')).toBe(true)
  await first.stop();hosts.splice(hosts.indexOf(first),1)
  const second=workflowHost(directory);hosts.push(second);await second.started
  expect(second.failureRelays).not.toHaveBeenCalled();expect(second.effects.pending('relay')).toBe(true)
  expect(second.store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind='relay'").get()?.n).toBe(1)
  expect(second.run(id)?.state).toBe('failed')
 })
 it('normal completion and parking a running workflow remain quiet',async()=>{
  const complete=await start('return {finished:true};');await until(()=>complete.h.run(complete.id)?.state==='completed')
  expect(complete.h.failureRelays).not.toHaveBeenCalled()
  const parked=await start("await agent('wait',{label:'wait'});");await until(()=>parked.h.offered().length)
  await parked.h.stop();hosts.splice(hosts.indexOf(parked.h),1)
  expect(parked.h.failureRelays).not.toHaveBeenCalled()
 })
 it('rolls back terminal bookkeeping if relay enqueue fails, preserving retriable failure visibility',async()=>{
  const {h,id}=await start("await agent('one',{label:'one'}); throw new Error('after');")
  await until(()=>h.offered().length);h.failureRelays.mockImplementation(()=>{throw Error('cannot enqueue')})
  h.accept('one');h.report('one','ok')
  await until(()=>h.board.all.workflow?.state==='error')
  expect(h.run(id)?.state).toBe('running');expect(h.run(id)?.failureRelayQueued).toBeUndefined()
 })
})
