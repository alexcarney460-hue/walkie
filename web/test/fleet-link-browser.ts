import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { encodeFleetLink, newLinkSecret } from '../../src/daemon/fleet-link.ts';
import { generateKeys } from '../../src/daemon/keys.ts';
// Standalone, model-free browser regression fixture (build web/dist first).
// bun web/test/fleet-link-browser.ts <owned-artifact-directory> <chromium-executable>
const root=process.argv[2],chrome=process.argv[3];
if(!root||!chrome||!isAbsolute(root)||!isAbsolute(chrome))throw Error('absolute fixture output and Chromium paths required');
mkdirSync(root,{recursive:true});
const source=resolve(import.meta.dir,'../..');
const profile=mkdtempSync(join(root,'fleet-link-browser-'));
const app=Bun.spawn(['bun','web/mock/server.ts'],{cwd:source,env:{...process.env,WALKIE_MOCK_PORT:'0',WALKIE_MOCK_TRANSPORT:'direct'},stdout:'pipe',stderr:Bun.file(root+'/browser-mock.log')});
let ws:WebSocket|undefined,child:ReturnType<typeof Bun.spawn>|undefined,site:ReturnType<typeof Bun.serve>|undefined;
const checks:any[]=[],wire:any[]=[],errors:any[]=[],admissions:any[]=[],external:string[]=[];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>Promise<any>){for(let i=0;i<100;i++){let v=await fn();if(v)return v;await sleep(100);}throw Error('condition timeout');}
const check=(name:string,ok:any,kind='control',detail:any=null)=>{checks.push({name,ok:!!ok,kind,detail});console.log((ok?'PASS ':'FAIL ')+name);};
try {
 const first=new TextDecoder().decode((await app.stdout.getReader().read()).value);const appUrl=first.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!appUrl)throw Error('mock URL missing');
 const paths:string[]=[];
 site=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const p=new URL(req.url).pathname;paths.push(p);if(p.includes('..'))return new Response('',{status:400});return new Response(Bun.file(source+'/site'+(p==='/join'?'/join.html':p)));}});
 child=Bun.spawn([chrome,'--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdout:Bun.file(root+'/browser-chrome.log'),stderr:Bun.file(root+'/browser-chrome.log')});
 const port=await until(async()=>{try{return (await Bun.file(profile+'/DevToolsActivePort').text()).split('\n')[0];}catch{return null;}});
 const tabs:any=await(await fetch('http://127.0.0.1:'+port+'/json')).json();ws=new WebSocket(tabs[0].webSocketDebuggerUrl);await new Promise<void>((r,j)=>{ws!.onopen=()=>r();ws!.onerror=j;});
 let seq=0;const pending=new Map<number,any>();
 const call=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws!.send(JSON.stringify({id,method,params}));});
 let linkMode='error';let staleView:any=null;
 const oldLink='a'.repeat(32), newLink='b'.repeat(32), node='c'.repeat(16), oldGeneration='d'.repeat(32), newGeneration='e'.repeat(32);
 const row=(id:string,handle:string)=>({id,short:id.slice(0,8),handle,role:handle==='owner'?'owner':'member',uses:5,used:0,pending:1,expires_at:Date.now()+86400000,approve:true,created_at:Date.now(),created_by:'owner',revoked_at:null,state:'active'});
 staleView={links:[row(oldLink,'target'),row(newLink,'owner')],uses:[{link:oldLink,node_id:node,hostname:'fixture-waiter',state:'pending',at:Date.now(),generation:oldGeneration}],authority:'fixture-authority'};
 let replaced=false;
 ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(m.error):p?.resolve(m.result);return;}
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);
  if(m.method==='Network.requestWillBeSent')wire.push(m.params.request);
  if(m.method==='Fetch.requestPaused'){
   const p=m.params,u=new URL(p.request.url);
   const fulfill=(body:any,status=200)=>call('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Cache-Control',value:'no-store'}],body:Buffer.from(JSON.stringify(body)).toString('base64')});
   if(u.hostname!=='127.0.0.1'){external.push(u.origin);void call('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'});}
   else if(u.pathname==='/v1/team/links'&&p.request.method==='GET'&&linkMode!=='normal')void fulfill(linkMode==='error'?{error:{code:'authority_unreachable',message:'Synthetic authority offline'}}:staleView,linkMode==='error'?503:200);
   else if(u.pathname==='/v1/team/admit'||u.pathname==='/v1/team/admit-link'){
    const body=JSON.parse(p.request.postData||'{}'); const stale=replaced&&body.link===oldLink&&body.generation===oldGeneration;
    admissions.push({...body,refused:stale});void fulfill(stale?{error:{code:'stale_join_request',message:'This join request changed; refresh before deciding it'}}:{event:null},stale?409:200);
   }
   else void call('Fetch.continueRequest',{requestId:p.requestId});
  }
 };
 await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Fetch.enable',{patterns:[{urlPattern:'http*'}]});
 const ev=async(expression:string)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const shot=async(name:string)=>{const r=await call('Page.captureScreenshot');await Bun.write(root+'/'+name+'.png',Buffer.from(r.data,'base64'));};
 const key=async(name:string,code:number,modifiers=0)=>{await call('Input.dispatchKeyEvent',{type:'keyDown',modifiers,key:name,code:name,windowsVirtualKeyCode:code});await call('Input.dispatchKeyEvent',{type:'keyUp',modifiers,key:name,code:name,windowsVirtualKeyCode:code});};
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:appUrl+'/#/team'});
 await until(()=>ev("document.body.textContent.includes('Synthetic authority offline')"));check('dashboard renders authority-unreachable error',true);await shot('dashboard-offline');
 linkMode='stale';await ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Retry')).click()");
 await until(()=>ev("document.querySelectorAll('.fleet-row').length===2"));check('Retry recovers fleet list from network error',true);
 // The owner rendered member A. The authority now holds owner B, without refreshing that rendered row.
 replaced=true;
 for(const label of ['Approve','Deny']) {
  await ev("[...document.querySelector('.fleet-row').querySelectorAll('button')].find(b=>b.textContent.includes("+JSON.stringify(label)+")).click()");
  await until(async()=>admissions.length===(label==='Approve'?1:2));
  check(label+' binds the rendered link AND generation after owner replacement',admissions.at(-1)?.link===oldLink&&admissions.at(-1)?.generation===oldGeneration&&admissions.at(-1)?.refused);
  await sleep(150);
 }
 check('stale decision shows actionable error',await ev("document.body.textContent.includes('This join request changed')"));await shot('dashboard-stale-member-decision');
 linkMode='normal';await ev("(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Add machines');b.focus();b.click()})()");await until(()=>ev("!!document.querySelector('#fl-title')"));await sleep(700);
 check('background opener is inert while modal is open',await ev("!![...document.querySelectorAll('button')].find(b=>b.textContent==='Add machines').closest('[inert]')"));
 check('owner confirmation starts unchecked and blocks mint',await ev("document.querySelector('[role=dialog] button[type=submit]').disabled"));
 await ev("document.querySelector('[role=dialog] button[aria-label=Close]').focus()");let escaped=false;
 for(let i=0;i<24;i++){await key('Tab',9);if(!await ev("!!document.activeElement.closest('[role=dialog]')")){escaped=true;break;}}
 if(escaped && await ev("document.activeElement.tagName==='BODY'"))await key('Tab',9);
 check('modal keyboard focus stays in its dialog',!escaped,'finding',await ev("({tag:document.activeElement.tagName,text:document.activeElement.textContent?.slice(0,80)})"));
 let reverseEscaped=false;
 for(let i=0;i<24;i++){await key('Tab',9,8);if(!await ev("!!document.activeElement.closest('[role=dialog]')")){reverseEscaped=true;break;}}
 check('modal Shift+Tab stays in its dialog',!reverseEscaped);
 await key('Escape',27);await until(()=>ev("!document.querySelector('#fl-title')"));check('Escape closes fleet drawer',true);check('Escape restores opener focus',await ev("document.activeElement.textContent==='Add machines' && !document.activeElement.closest('[inert]')"));
 await ev("(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Add machines');b.focus();b.click()})()");await sleep(700);
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(300);
 check('fleet drawer fits 390px viewport',await ev("(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"));await shot('dashboard-mobile-consent');
 await ev("[...document.querySelectorAll('[role=dialog] label')].find(l=>l.textContent.includes('Yes, grant owner-level')).querySelector('input').click()");await ev("document.querySelector('[role=dialog] button[type=submit]').click()");await until(()=>ev("!!document.querySelector('.am-result')"));check('mock result warns of owner-level access',await ev("document.querySelector('.am-result').textContent.includes('Owner-level access')"));await shot('dashboard-mock-result');
 const keys=generateKeys();const token=encodeFleetLink(keys,newLinkSecret().secret,{team:'0123456789abcdef',authority:keys.pubkey,handle:'fixture',uses:1,approve:true,expires_at:Date.now()+86400000});
 const siteUrl='http://127.0.0.1:'+site.port+'/join';
 await call('Page.navigate',{url:siteUrl+'#'+token+'&v=v0.2.0-pre.13'});await until(()=>ev("document.querySelector('[data-state=fleet]')?.classList.contains('is-on')"));
 check('join strips fragment and shows approval notice',await ev("location.hash==='' && [...document.querySelectorAll('[data-fleet-approve]')].some(x=>!x.hidden)"));
 check('join command contains exact synthetic token',await ev("document.querySelector('[data-field=fleet-command]').textContent.includes("+JSON.stringify(token)+")"));
 check('join page fits 390px viewport',await ev('document.documentElement.scrollWidth<=innerWidth'));await shot('join-valid-mobile');
 await call('Page.reload');await until(()=>ev("document.querySelector('[data-state=missing]')?.classList.contains('is-on')"));check('reload recovers to missing state and clears command',await ev("document.querySelector('[data-field=fleet-command]').textContent===''"));await shot('join-reload-missing');
 const expired=encodeFleetLink(keys,newLinkSecret().secret,{team:'0123456789abcdef',authority:keys.pubkey,handle:'fixture',uses:1,approve:false,expires_at:Date.now()-1000});
 await call('Page.navigate',{url:siteUrl+'#'+expired});await until(()=>ev("document.querySelector('[data-state=expired]')?.classList.contains('is-on')"));check('expired fragment recovery shows no executable command',await ev("document.querySelector('[data-field=fleet-command]').textContent==='' && location.hash===''"));
 await call('Page.navigate',{url:siteUrl+'#wl1-invalid'});await until(()=>ev("document.querySelector('[data-state=invalid]')?.classList.contains('is-on')"));check('malformed fragment recovery clears prior credentials',await ev("document.querySelector('[data-field=fleet-command]').textContent==='' && location.hash===''"));await shot('join-invalid');
 check('synthetic tokens absent from request URL, headers and bodies',!wire.some(r=>JSON.stringify({url:r.url,headers:r.headers,postData:r.postData}).includes(token)||JSON.stringify(r).includes(expired)));
 check('no browser runtime exceptions',errors.length===0);check('no external page requests',external.length===0);
 await Bun.write(root+'/browser-result.json',JSON.stringify({checks,errors,external,requestPaths:paths,admissions,source:process.argv[4]??'working tree; bind with file manifest'},null,2));
 if(checks.some(c=>!c.ok))process.exitCode=1;
}finally{ws?.close();child?.kill();app.kill();site?.stop(true);await Promise.all([child?.exited,app.exited]);rmSync(profile,{recursive:true,force:true});}
