import { expect, test } from "bun:test";
import { containsJoinCredential, containsJoinCredentialBytes, containsJoinCredentialValue, maskJoinCredentials } from "../../src/protocol/join-credential.ts";
import { cleanReport } from "../../src/protocol/projects/status-report.ts";
import { prepareMemoryText, prepareSource } from "../../src/daemon/memory/text.ts";
const suffix="Az09_-".repeat(24); // synthetic, never a usable credential
for(const prefix of ["wk1","wl1"]) {
 const token=prefix+suffix;
 const forms=[token,token.match(/.{1,8}/g)!.join(" "),"https://fixture.invalid/join#"+token,token.split("").map(c=>"%"+c.charCodeAt(0).toString(16)).join(""),token.split("").join("\u200b")];
 test(prefix+" shared string/value/byte detection covers normalized forms",()=>{
  for(const text of forms){expect(containsJoinCredential(text)).toBe(true);expect(containsJoinCredentialValue({nested:[text]})).toBe(true);expect(containsJoinCredentialBytes(new TextEncoder().encode(text))).toBe(true);}
 });
 test(prefix+" report output cannot retain a wrapped credential",()=>{
  for(const text of forms){const output=cleanReport("The fleet provisioning instructions are ready for review. Paste "+text+" on the new machines to join.",{prefixes:[]});expect(output===null||(!containsJoinCredential(output)&&!output.replace(/\s/g, "").includes(token))).toBe(true);}
 });
 test(prefix+" memory refuses credentials and source text",()=>{
  for(const text of forms.filter(x=>x.length<2000))expect(()=>prepareMemoryText(text)).toThrow("refuses join codes");
  expect(()=>prepareSource(token)).toThrow("refuses join codes");
 });
 test(prefix+" intentional private person delivery masks/restores raw bearer",()=>{const m=maskJoinCredentials("Private: "+token);expect(m.masked.includes(token)).toBe(false);expect(m.restore(m.masked)==="Private: "+token).toBe(true);});
}
test("legitimate non-token prose survives",()=>{for(const t of ["fleet wl1 format","wk1","ordinary planning notes"]){expect(containsJoinCredential(t)).toBe(false);expect(prepareMemoryText(t).text).toBe(t);}});
