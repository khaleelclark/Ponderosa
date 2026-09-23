import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {chromeBrowserDriverFactory,findBrowserExecutable} from "../dist/chrome-cdp-driver.js";

test("semantic browser observations redact password values while retaining ordinary form verification",{skip:!findBrowserExecutable()},async()=>{
  const root=mkdtempSync(join(tmpdir(),"browser-password-test-"));
  const server=createServer((_req,res)=>{
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.end('<main id="form"><input id="username" value="fixture-user"><input id="password" type="password" value="SYNTHETIC_TEST_SECRET"></main>');
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  let driver;
  try{
    driver=await chromeBrowserDriverFactory(root)("password",()=>{},undefined,undefined,{hostedHeaded:false});
    await driver.navigate(`http://127.0.0.1:${server.address().port}`);
    for(const selector of [undefined,"#form"]){
      const output=await driver.inspect(selector),snapshot=JSON.parse(output);
      assert.ok(!output.includes("SYNTHETIC_TEST_SECRET"));
      const password=snapshot.controls.find(control=>control.selector==="#password");
      assert.equal(password.text,"[redacted]");assert.equal(password.valueRedacted,true);
      assert.equal(snapshot.controls.find(control=>control.selector==="#username").text,"fixture-user");
    }
  }finally{
    if(driver){await driver.close();assert.equal(driver.isAlive(),false);}
    await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});
  }
});
