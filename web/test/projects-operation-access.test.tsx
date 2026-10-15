// Independent R120 mounted reproductions: exercise production components and store.
import {test,expect,afterEach} from 'bun:test';
import {act,create} from 'react-test-renderer';
import {installWindow} from './window-stub.ts';
installWindow();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const inert:any=new Proxy(()=>inert,{get:(_,k)=>k==='then'?undefined:k===Symbol.toPrimitive?()=> '':inert,apply:()=>undefined});
(globalThis as any).document=inert;
const {projectsStore:s}=await import('../src/state/projects.ts');
const {api}=await import('../src/api/client.ts');
const {ProjectBoard}=await import('../src/views/projects/ProjectBoard.tsx');
const {StaticStore}=await import('../src/state/store.tsx');
const {initialState}=await import('../src/state/reducer.ts');
const {useRoomUpload}=await import('../src/views/projects/RoomUpload.tsx');
const meter={mode:'count',done:0,counted:0,by_role:{backlog:0,todo:0,active:0,review:0,done:0,cancelled:0}};
const author={handle:'maren',node:'synthetic'};
const p:any={channel:'p-alpha',id:'p-alpha:1',name:'Synthetic Alpha',prefix:'ALPHA',folder:'',description:'',paths:[],meter_mode:'count',automations:{pr_opened:false,pr_merged:false,agents_can_close:false},state:'active',private:false,admins:[],creator:'maren',created_at:0,boards:[{id:'board:1',name:'Main',state:'active',created_at:0,created_by:author,columns:[{id:'todo',name:'To do',role:'todo'}],meter,live_cards:1}],cards:1,meter,last_activity:0};
const q:any={...p,channel:'p-beta',id:'p-beta:1',name:'Synthetic Beta'};
const card:any={id:'card:1',channel:p.channel,board:'board:1',key:'ALPHA-1',n:1,short:'0000',ref:'ALPHA-1-0000',title:'SYNTHETIC ALPHA CARD',body:'',column:'todo',pos:'m',assignee:null,reviewer:null,labels:[],estimate:null,due:null,blocked:false,blocked_reason:null,state:'open',created_at:0,created_by:author,updated_at:0,updated_by:author,comments:0,rev:0};
const base=()=>({status:'ready' as const,error:null,projects:[p,q],stubs:[],cards:{},cardsError:{},rooms:{},roomsError:{},visibilityGeneration:{[p.channel]:1,[q.channel]:2}});
const deferred=()=>{let resolve:any;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
const original={projects:api.projects,project:api.project,room:api.room,roomAdd:api.roomAdd,updateTask:api.updateTask,events:api.events};
afterEach(()=>{Object.assign(api,original);s.set({...base(),status:'idle',projects:[]});});
for(const kind of ['cards','rooms'] as const) test(`unrelated deletion must not strand a pending ${kind} load`,async()=>{
 s.set(base());const pending=deferred();let requests=0;
 api.project=async()=>{requests++;return pending.promise;};api.room=async()=>{requests++;return pending.promise;};
 const read=kind==='cards'?s.loadCards(p.channel):s.loadRoom(p.channel);
 const before=s.accessGeneration();s.delta({channel:q.channel,project:null});
 pending.resolve(kind==='cards'?{project:p,cards:[card]}:{files:[{id:'file:1',channel:p.channel,name:'Synthetic.txt'}],limits:{files:1000,versions:100}});
 await read;await Bun.sleep(0);
 console.log('UNRELATED_DELETE',JSON.stringify({kind,before,after:s.accessGeneration(),visible:s.isVisible(p.channel),requests,cached:s.get()[kind][p.channel]??null}));
 expect(s.get()[kind][p.channel]).toBeDefined();
});
test('mounted Alpha board must leave its skeleton after Beta deletion',async()=>{
 s.set(base());const pending=deferred();let requests=0;
 api.project=async()=>{requests++;return pending.promise;};api.room=async()=>({files:[],limits:{files:1000,versions:100}});
 let tree:any;
 try{
 await act(async()=>{tree=create(<StaticStore state={initialState}><ProjectBoard channel={p.channel}/></StaticStore>);});
 await act(async()=>{s.delta({channel:q.channel,project:null});pending.resolve({project:p,cards:[card]});});
 console.log('MOUNTED_DELETE',JSON.stringify({requests,render:JSON.stringify(tree.toJSON()).slice(0,600)}));
 expect(JSON.stringify(tree.toJSON()).includes(card.title)).toBe(true);
 }finally{await act(async()=>tree?.unmount());}
});
test('control: ordinary refresh retries the same pending load',async()=>{
 s.set(base());const pending=deferred();let requests=0;
 api.project=async()=>++requests===1?pending.promise:{project:p,cards:[card]};api.projects=async()=>({projects:[p],stubs:[]});
 const read=s.loadCards(p.channel);await s.refresh();pending.resolve({project:p,cards:[]});await read;await Bun.sleep(0);
 expect(s.get().cards[p.channel]).toEqual([card]);expect(requests).toBe(2);
});
for (const invalidate of [false, true]) test(`room upload batch ${invalidate ? 'stops after revoke/restore' : 'completes while access is unchanged'}`,async()=>{
 s.set({...base(),rooms:{[p.channel]:[]}});api.projects=async()=>({projects:[p],stubs:[]});api.room=async()=>({files:[],limits:{files:1000,versions:100}});
 const pending=deferred();const calls:string[]=[];let hook:any;let tree:any;
 const file=(name:string)=>({id:name,channel:p.channel,name});
 api.roomAdd=async(_ch,f)=>{calls.push(f.name);return calls.length===1?pending.promise:{file:file(f.name),created:true,version:1};};
 function Harness(){hook=useRoomUpload(p.channel);return hook.notice;}
 try{
 await act(async()=>{tree=create(<Harness/>);});let batch:Promise<void>;
 await act(async()=>{batch=hook.upload([new File(['one'],'first.txt'),new File(['two'],'second.txt')]);});
 if (invalidate) {
 await act(async()=>{await s.accessChanged({kind:'channel.upsert',body:{name:p.channel,members:[]}},'maren');});
 await act(async()=>{tree.unmount();tree=null;await s.accessChanged({kind:'channel.upsert',body:{name:p.channel,members:['maren']}},'maren');});
 }
 await act(async()=>{pending.resolve({file:file('first.txt'),created:true,version:1});await batch!;});
 console.log('BATCH_UPLOAD',JSON.stringify({calls,generation:s.accessGeneration()}));
 expect(calls).toEqual(invalidate ? ['first.txt'] : ['first.txt', 'second.txt']);
 }finally{await act(async()=>tree?.unmount());}
});
for (const invalidate of [false, true]) test(`ProjectBoard bulk move ${invalidate ? 'stops after revoke/restore' : 'completes while access is unchanged'}`,async()=>{
 const {Kanban}=await import('../src/views/projects/Kanban.tsx');
 const win=installWindow();const add=win.addEventListener;const remove=win.removeEventListener;
 const listeners=new Set<any>();
 (win as any).addEventListener=(t:string,fn:any)=>{if(t==='keydown')listeners.add(fn);else add(t,fn);};
 (win as any).removeEventListener=(t:string,fn:any)=>{if(t==='keydown')listeners.delete(fn);};
 const p2={...p,boards:[{...p.boards[0],columns:[...p.boards[0].columns,{id:'doing',name:'Doing',role:'active'}]}]};
 const c2={...card,id:'card:2',title:'SYNTHETIC SECOND CARD',pos:'z'};
 s.set({...base(),projects:[p2],cards:{[p.channel]:[card,c2]}});
 api.projects=async()=>({projects:[p2],stubs:[]});api.project=async()=>({project:p2,cards:[card,c2]});
 api.room=async()=>({files:[],limits:{files:1000,versions:100}});api.events=async()=>({events:[]});
 const calls:string[]=[];const pending=deferred();
 api.updateTask=async(id,body)=>{calls.push(id);return calls.length===1?pending.promise:{task:{...c2,...body}};};
 let tree:any;
 const key=async(k:string)=>act(async()=>{for(const fn of [...listeners])fn({key:k,target:null,preventDefault(){}});});
 try{
 await act(async()=>{tree=create(<StaticStore state={initialState}><ProjectBoard channel={p.channel}/></StaticStore>);});
 await act(async()=>tree.root.findByType(Kanban).props.onFocus({col:0,row:0}));await key('x');
 await act(async()=>tree.root.findByType(Kanban).props.onFocus({col:0,row:1}));await key('x');
 await key('m');await key('2');expect(calls).toEqual(['card:1']);
 if (invalidate) {
 await act(async()=>{await s.accessChanged({kind:'channel.upsert',body:{name:p.channel,members:[]}},'maren');});
 await act(async()=>{await s.accessChanged({kind:'channel.upsert',body:{name:p.channel,members:['maren']}},'maren');});
 }
 await act(async()=>{pending.resolve({task:{...card,column:'doing'}});await Bun.sleep(0);});
 console.log('BULK_MOVE',JSON.stringify({calls,generation:s.accessGeneration()}));
 expect(calls).toEqual(invalidate ? ['card:1'] : ['card:1', 'card:2']);
 }finally{await act(async()=>tree?.unmount());win.addEventListener=add;win.removeEventListener=remove;}
});

for (const kind of ['cards', 'rooms'] as const) {
 test(`unrelated deletion still surfaces a pending ${kind} failure`, async () => {
  s.set(base());
  const pending = deferred();
  api.project = async () => { await pending.promise; throw new Error('Synthetic read failed'); };
  api.room = async () => { await pending.promise; throw new Error('Synthetic read failed'); };
  const read = kind === 'cards' ? s.loadCards(p.channel) : s.loadRoom(p.channel);
  s.delta({channel: q.channel, project: null});
  pending.resolve();
  await read;
  expect(s.get()[kind === 'cards' ? 'cardsError' : 'roomsError'][p.channel]).toBe('Something went wrong. Try again.');
 });
 test(`deleted and readmitted channel rejects its old ${kind} response`, async () => {
  s.set(base());
  const pending = deferred();
  let requests = 0;
  api.projects = async () => ({projects: [p, q], stubs: []});
  api.project = async () => ++requests === 1 ? pending.promise : {project: p, cards: []};
  api.room = async () => ++requests === 1 ? pending.promise : {files: [], limits: {files: 1000, versions: 100}};
  const read = kind === 'cards' ? s.loadCards(p.channel) : s.loadRoom(p.channel);
  s.delta({channel: p.channel, project: null});
  await s.refresh();
  pending.resolve(kind === 'cards' ? {project: {...p, name: 'STALE'}, cards: [card]} : {files: [{id: 'stale', channel: p.channel}]});
  await read;
  await Bun.sleep(0);
  expect(s.get()[kind][p.channel]).toEqual([]);
  expect(s.get().projects.find(row => row.channel === p.channel)?.name).toBe(p.name);
 });
}
