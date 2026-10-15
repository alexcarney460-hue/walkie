import { afterEach, expect, test } from 'bun:test';
import { makeCore, reopen } from '../../test/helpers/core.ts';
import { tnode, type TNode } from '../../test/helpers/events.ts';
import { encodeFleetLink, newLinkSecret } from '../../src/daemon/fleet-link.ts';
import { registerLink, linksView, admitLinkJoin, revokeLink } from '../../src/daemon/fleet-link-service.ts';
import { admitJoin, applyRequest, signRequest } from '../../src/daemon/requests.ts';
import { PeerApi } from '../../src/daemon/peer-api.ts';
import { JOIN_REQUEST_TTL_MS } from '../../src/daemon/store.ts';
import { FakeIdentity } from '../../src/daemon/identity.ts';
import { newPeerNonce, signPeerRequest } from '../../src/daemon/peer-sig.ts';
const cleanup: (()=>void)[]=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()?.();});
function world(identity?: FakeIdentity) {
 let offset=0; const clock=()=>Date.now()+offset;
 const owner=tnode('owner','direct:owner'), target=tnode('target','direct:target'), issuer=tnode('issuer','direct:issuer');
 let core=makeCore(owner,'0000000000000000',cleanup,{clock,...(identity ? {identity} : {})}); core.store.deleteMeta('team'); core.createTeam('fixture','owner',{login:owner.login});
 const add=(n:TNode)=>core.emit('team.node',{node_id:n.keys.nodeId,login:n.login,hostname:n.hostname,pubkey:n.keys.pubkey,ip:'',endpoint:Buffer.from(n.keys.pubkey,'base64').toString('hex'),transports:['direct']});
 add(owner);
 for(const [n,role] of [[target,'member'],[issuer,'owner']] as const){core.emit('team.member',{login:n.login,handle:n.handle,role});add(n);}
 let api=new PeerApi(core);
 const mint=async({forNode=target,by=owner,approve=false,uses=5}={})=>{const {secret,id}=newLinkSecret();const f={handle:forNode.handle,uses,approve,expires_at:Math.floor((clock()+7*86400000)/1000)*1000};await registerLink(core,{id,...f,owner_machines:true},by.keys.nodeId);const token=encodeFleetLink(by.keys,secret,{...f,team:core.teamId!,authority:owner.keys.pubkey});return {id,token};};
 const join=async(n:TNode,token?:string,extra={})=>{const res=await api.handle(new Request('http://walkie.direct/peer/v1/join',{method:'POST',body:JSON.stringify({pubkey:n.keys.pubkey,hostname:n.hostname,ip:'',...(token?{link:token}:{}),...extra})}),{kind:'direct',pubkey:n.keys.pubkey});const b:any=await res.json();return {status:res.status,...b};};
 const tailJoin=async(n:TNode,ip:string)=>{const body=JSON.stringify({pubkey:n.keys.pubkey,hostname:n.hostname,ip});const headers=signPeerRequest(n.keys,{method:'POST',path:'/peer/v1/join',query:'',body,requester:n.keys.nodeId,target:core.nodeId,team:core.teamId!,ts:Date.now(),nonce:newPeerNonce()});const res=await api.handle(new Request('http://walkie.test/peer/v1/join',{method:'POST',body,headers:{...headers}}),ip);return {status:res.status,body:await res.json() as any};};
 return {get core(){return core;},owner,target,issuer,add,mint,join,tailJoin,advance:(n:number)=>{offset+=n;},restart:()=>{core=reopen(core,owner);cleanup.push(()=>core.close());api=new PeerApi(core);}};
}

test('MUST role round-trip must not resurrect a dead target link',async()=>{
 const w=world(),l=await w.mint(); w.core.emit('team.member',{login:w.target.login,handle:'target',role:'observer'});
 expect(linksView(w.core).links.find(x=>x.id===l.id)?.state).toBe('dead');
 w.core.emit('team.member',{login:w.target.login,handle:'target',role:'member'});
 const r=await w.join(tnode('role-roundtrip'),l.token);
 expect(r.admitted).not.toBe(true);
});

test('MUST issuer demotion restoration must not resurrect a dead link',async()=>{
 const w=world(),l=await w.mint({by:w.issuer});w.core.emit('team.member',{login:w.issuer.login,handle:'issuer',role:'member'});
 expect(linksView(w.core).links.find(x=>x.id===l.id)?.state).toBe('dead');
 w.core.emit('team.member',{login:w.issuer.login,handle:'issuer',role:'owner'});
 const r=await w.join(tnode('issuer-roundtrip'),l.token);expect(r.admitted).not.toBe(true);
});

test('revoking and re-admitting the issuing machine keeps its old link dead',async()=>{
 const w=world(),l=await w.mint({by:w.issuer,approve:true}),n=tnode('issuer-revoked-waiter');
 expect((await w.join(n,l.token)).reason).toBe('pending_approval');
 const pending=w.core.store.joinRequest(n.keys.nodeId,w.core.clock())!;
 w.core.emit('team.node',{node_id:w.issuer.keys.nodeId,login:w.issuer.login,hostname:w.issuer.hostname,pubkey:w.issuer.keys.pubkey,ip:'',revoked:true});
 expect(linksView(w.core).links.find(x=>x.id===l.id)?.state).toBe('dead');
 w.add(w.issuer); w.restart();
 expect(linksView(w.core).links.find(x=>x.id===l.id)?.state).toBe('dead');
 expect(()=>admitLinkJoin(w.core,pending,true)).toThrow();
 expect((await w.join(tnode('issuer-revoked-fresh'),l.token)).error.code).toBe('link_issuer_not_owner');
 const fresh=await w.mint({by:w.issuer});
 expect((await w.join(tnode('issuer-revoked-new'),fresh.token)).admitted).toBe(true);
});

test('another login cannot unbind a pending fleet request and revocation drops it',async()=>{
 const observer=tnode('observer','observer@example.com'),identity=new FakeIdentity({ip:'127.0.0.1',login:'owner@example.com',nodeName:'owner'},new Map(),new Map([['100.64.0.2',{login:observer.login,nodeName:observer.hostname}]]));
 const w=world(identity),l=await w.mint({forNode:w.owner,approve:true}),n=tnode('pending-owner');
 w.core.emit('team.member',{login:observer.login,handle:observer.handle,role:'observer'});
 expect((await w.join(n,l.token)).reason).toBe('pending_approval');
 const pending=w.core.store.joinRequest(n.keys.nodeId,w.core.clock())!;
 const tail=await w.tailJoin(n,'100.64.0.2');
 expect(tail).toMatchObject({status:409,body:{error:{code:'link_pending_elsewhere'}}});
 expect(()=>w.core.store.addJoinRequest({node_id:n.keys.nodeId,login:observer.login,pubkey:n.keys.pubkey,hostname:'tailnet',ip:'100.64.0.2',port:7458,requested_at:w.core.clock()})).toThrow();
 expect(w.core.store.joinRequest(n.keys.nodeId,w.core.clock())).toEqual(pending);
 revokeLink(w.core,l.id,'owner');
 expect(w.core.store.joinRequest(n.keys.nodeId,w.core.clock())).toBeNull();
});

test('MUST stale displayed member request cannot approve or deny its owner replacement', async()=>{
 const w=world(),a=await w.mint({approve:true}),b=await w.mint({forNode:w.owner,approve:true}),n=tnode('rebind');
 await w.join(n,a.token); const old=w.core.store.joinRequest(n.keys.nodeId,w.core.clock())!;
 w.advance(JOIN_REQUEST_TTL_MS+1000); await w.join(n,b.token);
 const replacement=w.core.store.joinRequest(n.keys.nodeId,w.core.clock())!;
 for(const approve of [true,false]) {
  expect(()=>admitJoin(w.core,n.keys.nodeId,approve,'owner',undefined,{link:a.id,generation:old.generation!})).toThrow();
  expect(w.core.store.joinRequest(n.keys.nodeId,w.core.clock())).toEqual(replacement);
 }
 expect(linksView(w.core).uses.some(u=>u.link===a.id&&u.state==='pending')).toBe(false);
 expect(()=>admitJoin(w.core,n.keys.nodeId,true,'owner')).toThrow();
 admitJoin(w.core,n.keys.nodeId,true,'owner',undefined,{link:b.id,generation:replacement.generation!});
 expect(w.core.roster.nodes.get(n.keys.nodeId)?.login).toBe(w.owner.login);
});

function binding(w: ReturnType<typeof world>, node: TNode) {
 const j=w.core.store.joinRequest(node.keys.nodeId,w.core.clock())!;
 return {link:j.link!,generation:j.generation!};
}

test('same-link expiry creates a new generation; stale snapshot/deny cannot decide it',async()=>{
 const w=world(),l=await w.mint({approve:true,uses:1}),n=tnode('same-link');
 await w.join(n,l.token);const old=w.core.store.joinRequest(n.keys.nodeId,w.core.clock())!;
 await w.join(n,l.token);expect(binding(w,n).generation).toBe(old.generation!);
 w.advance(JOIN_REQUEST_TTL_MS+1);await w.join(n,l.token);const fresh=binding(w,n);
 expect(fresh.generation===old.generation).toBe(false);
 for(const approve of [true,false])expect(()=>admitLinkJoin(w.core,old,approve)).toThrow('changed or expired');
 expect(w.core.store.links.counted(l.id,w.core.clock())).toEqual({used:0,pending:1});
 admitJoin(w.core,n.keys.nodeId,true,undefined,undefined,fresh);
 expect(w.core.roster.nodes.get(n.keys.nodeId)?.login).toBe(w.target.login);
});

test('signed forwarded owner decisions bind link and generation, including deny and replay',async()=>{
 const w=world(),a=await w.mint({approve:true}),b=await w.mint({approve:true,forNode:w.owner}),n=tnode('forwarded');
 const sender=makeCore(w.issuer,w.core.teamId!,cleanup,{clock:w.core.clock});
 await w.join(n,a.token);const old=binding(w,n);
 const requests=[true,false].map(approve=>signRequest(sender,'team.admit-link',{node_id:n.keys.nodeId,approve,...old}));
 w.advance(JOIN_REQUEST_TTL_MS+1);await w.join(n,b.token);const fresh=binding(w,n);
 for(const req of requests)expect(()=>applyRequest(w.core,req)).toThrow();
 expect(binding(w,n)).toEqual(fresh);
 const signed=signRequest(sender,'team.admit-link',{node_id:n.keys.nodeId,approve:true,...fresh});
 expect(()=>applyRequest(w.core,{...signed,body:{...signed.body,generation:old.generation}})).toThrow('bad request signature');
 const event=applyRequest(w.core,signed);
 expect(w.core.roster.nodes.get(n.keys.nodeId)?.login).toBe(w.owner.login);
 expect(applyRequest(w.core,signed)?.id).toBe(event?.id);
 expect(w.core.store.links.counted(b.id,w.core.clock())).toEqual({used:1,pending:0});
});

test('legacy node-only decisions fail closed on fleet requests; fresh deny frees its reservation',async()=>{
 const w=world(),l=await w.mint({approve:true}),n=tnode('legacy');await w.join(n,l.token);
 for(const approve of [true,false]) {
  expect(()=>admitJoin(w.core,n.keys.nodeId,approve)).toThrow();
  expect(()=>applyRequest(w.core,signRequest(w.core,'team.admit',{node_id:n.keys.nodeId,approve}))).toThrow();
 }
 admitJoin(w.core,n.keys.nodeId,false,undefined,undefined,binding(w,n));
 expect(w.core.store.joinRequest(n.keys.nodeId,w.core.clock())).toBeNull();
 expect((await w.join(n)).error.code).toBe('link_declined');
});

for(const issuer of [false,true])test((issuer?'issuer':'target')+' role round trip stays dead for pending approval and poll across restart',async()=>{
 const w=world(),l=await w.mint({by:issuer?w.issuer:w.owner,approve:true}),n=tnode('role-pending');
 await w.join(n,l.token);const j=w.core.store.joinRequest(n.keys.nodeId,w.core.clock())!;
 const who=issuer?w.issuer:w.target,role=issuer?'owner':'member';
 w.core.emit('team.member',{login:who.login,handle:who.handle,role:issuer?'member':'observer'});
 w.core.emit('team.member',{login:who.login,handle:who.handle,role});w.restart();
 expect(linksView(w.core).links.find(x=>x.id===l.id)?.state).toBe('dead');
 expect(()=>admitLinkJoin(w.core,j,true)).toThrow();
 expect((await w.join(n)).admitted).not.toBe(true);
 expect((await w.join(n)).error.code).toBe(issuer?'link_issuer_not_owner':'link_role_changed');
 const fresh=await w.mint({by:issuer?w.issuer:w.owner});
 expect((await w.join(tnode('restored-new'),fresh.token)).admitted).toBe(true);
});

test('role cutoffs derive from accepted history and roll back with the signed append; cosmetic restates preserve links',async()=>{
 const w=world(),l=await w.mint({by:w.issuer});const before=w.core.roster;
 expect(()=>w.core.store.transaction(()=>{
  w.core.emit('team.member',{login:w.target.login,handle:'target',role:'observer'});
  w.core.emit('team.member',{login:w.issuer.login,handle:'issuer',role:'member'});
  throw Error('fixture rollback');
 })).toThrow('fixture rollback');
 expect(w.core.roster.members.get(w.target.login)).toEqual(before.members.get(w.target.login));
 expect(w.core.roster.members.get(w.issuer.login)).toEqual(before.members.get(w.issuer.login));
 for(const n of [w.target,w.issuer])w.core.emit('team.member',{login:n.login,handle:n.handle,role:n===w.target?'member':'owner',display_name:'Fixture rename'});
 w.restart();expect((await w.join(tnode('after-rollback'),l.token)).admitted).toBe(true);
});

test('upgrade of a legacy pending row preserves its cap and requires a fresh bound decision',async()=>{
 const w=world(),l=await w.mint({approve:true,uses:1}),n=tnode('old-pending');await w.join(n,l.token);
 w.core.store.db.query('UPDATE join_requests SET generation = NULL WHERE node_id = ?').run(n.keys.nodeId);
 w.core.store.db.query('UPDATE fleet_link_uses SET generation = NULL WHERE node_id = ?').run(n.keys.nodeId);
 w.restart();
 expect(w.core.store.links.counted(l.id,w.core.clock())).toEqual({used:0,pending:1});
 expect(linksView(w.core).uses.some(u=>u.state==='pending')).toBe(false);
 expect(()=>admitJoin(w.core,n.keys.nodeId,true)).toThrow();
 expect((await w.join(tnode('cap-held'),l.token)).error.code).toBe('link_used_up');
 expect((await w.join(n,l.token)).reason).toBe('pending_approval');
 expect(typeof binding(w,n).generation).toBe('string');
 expect(w.core.store.links.counted(l.id,w.core.clock())).toEqual({used:0,pending:1});
 admitJoin(w.core,n.keys.nodeId,true,undefined,undefined,binding(w,n));
 expect(w.core.store.links.counted(l.id,w.core.clock())).toEqual({used:1,pending:0});
});

test('a mismatched historical use never lends capacity to a replacement generation',async()=>{
 const w=world(),l=await w.mint({approve:true,uses:1}),n=tnode('mismatched-generation');await w.join(n,l.token);
 // Mixed-version/partial historical rows: this request has no matching reservation, and the last use is spent.
 w.core.store.db.query('UPDATE join_requests SET generation = NULL WHERE node_id = ?').run(n.keys.nodeId);
 w.core.store.links.record({link:l.id,node_id:tnode('spent').keys.nodeId,hostname:'spent',state:'admitted',reason:null,at:w.core.clock()});
 expect(w.core.store.links.counted(l.id,w.core.clock())).toEqual({used:1,pending:0});
 expect((await w.join(n,l.token)).error?.code).toBe('link_used_up');
 expect(w.core.store.links.counted(l.id,w.core.clock())).toEqual({used:1,pending:0});
});
