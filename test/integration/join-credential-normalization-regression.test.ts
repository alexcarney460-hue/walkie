import {afterAll,beforeAll,expect,test} from 'bun:test';
import {Cluster,type TestNode} from '../helpers/cluster.ts';
import {containsJoinCredential as detect,containsJoinCredentialValue as value,containsJoinCredentialBytes as bytes} from '../../src/protocol/join-credential.ts';
import {readBlob} from '../../src/daemon/blobs.ts';
let c:Cluster,n:TestNode;
beforeAll(async()=>{c=new Cluster();n=await c.add({name:'regression',login:'-',direct:true});await n.client().init('fixture','regression');});
afterAll(async()=>{await c?.close();});
for(const prefix of ['wk1','wl1']) for(const [label,poison] of [['full-width percent','％'],['small percent','﹪'],['malformed compatible escape','％GG']]) {
 test(`${prefix} existing percent-decoding protection survives ${label}`,async()=>{
  const toy=prefix+'Az09_-'.repeat(24); // unusable unsigned synthetic pattern
  const encoded=toy.split('').map(x=>'%'+x.charCodeAt(0).toString(16)).join('');
  const text=encoded+' '+poison;const data=new TextEncoder().encode(text);
  expect(decodeURIComponent(text).includes(toy)).toBe(true);
  let coreRefused=false,corePersisted=false;
  try {const ev=n.d.core.emit('msg.post',{text},{channel:'general',agent:'probe'});corePersisted=n.d.core.store.getRow(ev.id)?.json.includes(text)??false;}
  catch(e:any){coreRefused=e.code==='join_credential_private_reply_only';}
  const post:any=await n.client('probe').post({channel:'general',text,raw:true}).then(x=>({ok:true,...x}),e=>({ok:false,code:e.code}));
  const upload:any=await n.client('probe').share(data,{name:'fixture.txt',mime:'text/plain'}).then(x=>({ok:true,...x}),e=>({ok:false,code:e.code}));
  const postPersisted=post.ok && n.d.core.store.getRow(post.event.id)?.json.includes(text);
  const uploadPersisted=upload.ok && new TextDecoder().decode(readBlob(n.d.core.paths.blobs,upload.event.body.hash)!)===text;
  const results=[detect(text),value({nested:[{text}]}),bytes(data),coreRefused,post.code==='join_credential_private_reply_only',upload.code==='join_credential_private_reply_only'];
  console.log('REGRESSION_MATRIX',JSON.stringify({prefix,label,detectedAndRefused:results,corePersisted,postPersisted:!!postPersisted,uploadPersisted:!!uploadPersisted}));
  expect(results).toEqual([true,true,true,true,true,true]);
 });
}
