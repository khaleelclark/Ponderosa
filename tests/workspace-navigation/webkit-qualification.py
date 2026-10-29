# W3C WebDriver + installed GTK clipboard, standard library only. WebKitGTK is not Safari/iOS.
import base64,json,pathlib,subprocess,time,urllib.request,urllib.error
OUT=pathlib.Path('/evidence'); FIX=json.loads((OUT/'fixture.json').read_text()); ROOT='http://127.0.0.1:4445'; session=None; results=[]; cases=[]; clipboard=None
ELEMENT='element-6066-11e4-a52e-4f735466cecf'

def http(method,url,data=None):
 body=None if data is None else json.dumps(data).encode()
 try:
  with urllib.request.urlopen(urllib.request.Request(url,data=body,headers={'Content-Type':'application/json'},method=method),timeout=40) as response:return json.load(response)
 except urllib.error.HTTPError as e:
  payload=e.read().decode();raise RuntimeError(str(e)+' '+payload) from e

def wd(method,path,data=None):return http(method,ROOT+('/session/'+session if session else '')+path,data).get('value')
def js(script,*args):return wd('POST','/execute/sync',{'script':script,'args':list(args)})
def wait(fn,reason,seconds=15):
 end=time.monotonic()+seconds;last=None
 while time.monotonic()<end:
  try:
   value=fn()
   if value:return value
  except Exception as e:last=str(e)
  time.sleep(.1)
 raise AssertionError(reason+(': '+last if last else ''))
def visible_script():return 'const visible=e=>!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=="hidden";'
def label(name):return wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('[aria-label],input,textarea,[contenteditable],[role=combobox]')].find(e=>visible(e)&&(e.getAttribute('aria-label')===arguments[0]||(e.getAttribute('aria-labelledby')||'').split(' ').some(id=>document.getElementById(id)?.textContent.trim()===arguments[0])||[...document.querySelectorAll('label')].some(l=>l.htmlFor&&l.htmlFor===e.id&&l.textContent.trim()===arguments[0])));''',name),'label '+name)
def button(name,role=None):
 return wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="tab"]')].find(e=>visible(e)&&(!arguments[1]||e.getAttribute('role')===arguments[1])&&(e.getAttribute('aria-label')===arguments[0]||e.textContent.replace(/\\s+/g,' ').trim()===arguments[0]));''',name,role),'button '+name)
def click(e):
 js('arguments[0].scrollIntoView({block:"center",inline:"center"});',e)
 wait(lambda:js('const e=arguments[0],r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(e===hit||e.contains(hit));',e),'native click target unobstructed');time.sleep(.1)
 return wd('POST','/element/'+e[ELEMENT]+'/click',{})
def keys(e,text):return wd('POST','/element/'+e[ELEMENT]+'/value',{'text':text})
def chord(*values):
 seq=[{'type':'keyDown','value':v} for v in values]+[{'type':'keyUp','value':v}for v in reversed(values)]
 return wd('POST','/actions',{'actions':[{'type':'key','id':'keyboard','actions':seq}]})
def set_field(e,text):
 js('const e=arguments[0];Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(e,arguments[1]);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));',e,text)
def value(e):return js('return arguments[0].value;',e)
def draft(e):
 # WebKit innerText adds a block terminator. Read every explicit Lexical span/br instead, never trim body text.
 return js("""const root=arguments[0];if(root.children.length!==1||root.firstElementChild.tagName!=="P")throw Error("Unexpected plain-text editor tree");const p=root.firstElementChild;if(p.childNodes.length===1&&p.firstChild.nodeName==="BR")return "";return [...p.childNodes].map(n=>{if(n.nodeType===Node.TEXT_NODE)return n.nodeValue;if(n.nodeName==="BR")return "\\n";if(n.nodeName==="SPAN"&&n.hasAttribute("data-lexical-text"))return n.textContent;throw Error("Unexpected plain-text draft node "+n.nodeName);}).join("");""",e).replace('\r\n','\n')

def text():return js('return document.body.innerText;')
def alerts(needle):return js('return [...document.querySelectorAll("[role=alert]")].filter(e=>e.getClientRects().length&&e.textContent.includes(arguments[0])).map(e=>e.textContent);',needle)
def snapshot(row,suffix):
 (OUT/(row['id']+'-'+suffix+'.png')).write_bytes(base64.b64decode(wd('GET','/screenshot')))
 (OUT/(row['id']+'-'+suffix+'.txt')).write_text(text())
 (OUT/(row['id']+'-'+suffix+'.html')).write_text(js('return document.documentElement.outerHTML;'))
def monitor():js('window.qualificationErrors=[];window.qualificationPastes=[];addEventListener("error",e=>qualificationErrors.push({type:"error",message:e.message}),true);addEventListener("unhandledrejection",e=>qualificationErrors.push({type:"rejection",message:String(e.reason)}));addEventListener("paste",e=>qualificationPastes.push({trusted:e.isTrusted,text:e.clipboardData.getData("text/plain")}),true);')
def collect(row):row['pageErrors']+=js('return window.qualificationErrors||[];') or []
def go(url,row=None):
 if row:collect(row)
 wd('POST','/url',{'url':url});wait(lambda:js('return document.readyState==="complete";'),'page complete');monitor()
def fault(kind):http('POST',FIX['origin']+'/api/__qualification/fault',{'kind':kind})
def prefs(url):return http('GET',url)
def choose_font(target):
 click(label('Font'));button('Inter','option');chord('\ue011')
 for i in range(2 if target=='sans'else 1):chord('\ue015')
 expected='Classic Sans'if target=='sans'else'System'
 wait(lambda:js('return document.activeElement.textContent.trim();')==expected,'Font keyboard option focus')
 chord('\ue007');wait(lambda:not js(visible_script()+'return [...document.querySelectorAll(\'[role="listbox"]\')].some(visible);'),'Font menu closed')

def arm_clipboard(payload):
 global clipboard
 if clipboard:clipboard.terminate();clipboard.wait(timeout=5)
 clipboard=subprocess.Popen(['python3','/qualification/webkit-clipboard.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 clipboard.stdin.write(payload.encode());clipboard.stdin.close();assert clipboard.stdout.readline().decode().strip()=='READY','Native GTK clipboard ready'
def settings(product,theme,row):
 url=FIX['origin']+('/api/workspace/preferences'if product=='core'else'/api/branches/engine/workspace/preferences');before=prefs(url)
 go(FIX['origin']+('/settings/general'if product=='core'else'/branches?settings=general'),row);field=label('Global Agent Instructions');oversized='λ'*100000+'😀TAIL';set_field(field,oversized);click(button('Save Agent Defaults'))
 needle='at most 100,000';wait(lambda:len(alerts(needle))==1,'one rejected-save error');assert not alerts('Workspace settings could not be saved.');assert value(field)==oversized;after=prefs(url);assert before['globalInstructions']==after['globalInstructions'] and before['revision']==after['revision'];snapshot(row,'rejected-save');row['checks'].append('Oversized save: one exact error; exact dirty draft and stored text/revision retained')
 corrected=row['id']+' corrected λ😀';set_field(field,corrected);click(button('Save Agent Defaults'));wait(lambda:prefs(url)['globalInstructions']==corrected,'corrected canonical save');wait(lambda:not alerts(needle),'error removed after corrected save');row['checks'].append('Corrected save clears rejected-save error')
 target='sans'if before.get('fontFamily')=='system'else'system';option='Classic Sans'if target=='sans'else'System';fault('font');choose_font(target);err='WebKit qualification font outage';wait(lambda:len(alerts(err))==1,'one immediate-save error');assert prefs(url).get('fontFamily')!=target;snapshot(row,'font-error');fault(None);choose_font(target);wait(lambda:prefs(url).get('fontFamily')==target,'font retry canonical save');wait(lambda:not alerts(err),'font error removed');row['checks'].append('Immediate save: exact failure, unchanged canonical font, successful retry and no stale error');snapshot(row,'settings-recovered')
 row['renderedSettings']=text()
def chat(product,theme,row):
 go(FIX['normalUrl']if product=='core'else FIX['url'],row);editor=label('Message')
 click(button('Chat settings and actions'));click(button('Rename','menuitem'));name=label('Chat name');renamed=row['id']+' renamed';set_field(name,renamed);fault('rename');click(name);chord('\ue007');err='WebKit qualification rename outage';wait(lambda:len(alerts(err))==1,'rename rejection visible');assert value(name)==renamed;snapshot(row,'rename-error');fault(None);click(name);chord('\ue007');wait(lambda:not js('return [...document.querySelectorAll("input")].some(e=>e.getClientRects().length&&e.value===arguments[0]);',renamed),'rename retry closes dialog');row['checks'].append('Rename Enter failure retains title; retry succeeds')
 editor=label('Message')
 for ending in ['\n','\r\n']:
  marker=row['id']+('-lf'if ending=='\n'else'-crlf');payload=ending.join([marker+' λ😀','second line','','TAIL_KEEP_ME']);normalized=payload.replace('\r\n','\n');click(editor);chord('\ue009','a');chord('\ue003');arm_clipboard(payload);chord('\ue009','v');wait(lambda:len(js('return window.qualificationPastes;'))>0,'trusted paste event');paste=js('return window.qualificationPastes.at(-1);');assert paste['trusted'];assert paste['text']==normalized,('exact browser-delivered clipboard text',paste);paste['rawPayloadExact']=paste['text']==payload;paste['lineEndingDisposition']='exact'if paste['rawPayloadExact']else'WebKit normalized native CRLF to LF before application paste listener';row['pasteDom']=js('return {html:arguments[0].innerHTML,text:arguments[0].textContent,innerText:arguments[0].innerText};',editor);assert draft(editor)==normalized,('exact pasted draft',row['pasteDom'],normalized);chord('\ue008','\ue007');keys(editor,'SHIFT_TAIL');expected=normalized+'\nSHIFT_TAIL';assert draft(editor)==expected,('Shift+Enter draft',draft(editor));snapshot(row,'paste-'+('lf'if ending=='\n'else'crlf'));click(button('Send message'));wait(lambda:marker in text() and not draft(editor).strip(),'one explicit send clears composer');cases.append({'marker':marker,'product':product,'row':row['id'],'payload':payload,'expected':expected,'pasteEvent':paste});row['checks'].append('Trusted '+('LF'if ending=='\n'else'CRLF')+' paste: exact draft, Shift+Enter and explicit send');time.sleep(.8)
 # Record actual dialog/menu text without starting microphone/audio/provider work.
 click(button('Chat settings and actions'));row['chatMenuText']=text();snapshot(row,'chat-menu');chord('\ue00c')
 row['callEntryCandidates']=js('return [...document.querySelectorAll("button")].filter(e=>e.getClientRects().length&&/call/i.test(e.getAttribute("aria-label")||e.textContent)).map(e=>({label:e.getAttribute("aria-label"),text:e.textContent,disabled:e.disabled}));')
 # Voice options is shared by both products. Opening/typing locally never starts audio or a provider turn.
 voice=js(visible_script()+"""return [...document.querySelectorAll('button[aria-label="Voice options"]')].find(e=>visible(e));""")
 if voice:
  click(voice);row['voiceMenuText']=text();snapshot(row,'voice-menu')
  call=js(visible_script()+"""return [...document.querySelectorAll('[role="menuitem"]')].find(e=>visible(e)&&e.textContent.trim().startsWith("Voice call"));""")
  assert call,'Voice call entry'
  if js('return arguments[0].getAttribute("aria-disabled")!=="true";',call):
   click(call);wait(lambda:js(visible_script()+"""return [...document.querySelectorAll('[role="dialog"]')].some(visible);"""),'call dialog');row['callInitialText']=text();snapshot(row,'call-initial');click(button('Transcript & typing'));turn=label('Your next turn');set_field(turn,'Unsent local qualification draft λ😀');wait(lambda:'Send or clear your draft before starting a call.'in text(),'unsent-call hint');row['callExpandedText']=text();snapshot(row,'call-unsent');click(button('End call'));wait(lambda:not js(visible_script()+"""return [...document.querySelectorAll('[role="dialog"]')].some(visible);"""),'call closed');row['checks'].append('Call initial/unavailable and expanded unsent-draft text captured; End call without audio/send')
  else:
   row['callDisposition']='Voice call disabled in this actual shared context; menu text captured';chord('\ue00c')
 else:row['callDisposition']='No visible Voice options in this actual shared context'
 collect(row)
try:
 wait(lambda:http('GET',ROOT+'/status').get('value',{}).get('ready'),'WebDriver ready')
 for width,height,viewport in [(1440,1000,'desktop'),(390,844,'mobile-viewport')]:
  for product in ['core','branches']:
   for theme in ['light','dark']:
    row={'id':product+'-'+theme+'-'+viewport,'product':product,'theme':theme,'requestedWindow':{'width':width,'height':height},'checks':[],'pageErrors':[]};results.append(row)
    result=http('POST',ROOT+'/session',{'capabilities':{'alwaysMatch':{'browserName':'MiniBrowser'}}})['value'];session=result['sessionId'];row['engine']=result['capabilities']
    try:
     wd('POST','/window/rect',{'width':width,'height':height});go(FIX['origin']);js('localStorage.setItem("ponderosa-color-mode",arguments[0]);',theme);go(FIX['origin']);row['viewport']=js('return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,userAgent:navigator.userAgent};');settings(product,theme,row);chat(product,theme,row);assert not row['pageErrors'],row['pageErrors'];row['status']='pass';print('PASS '+row['id']+': '+str(len(row['checks']))+' checks',flush=True)
    except Exception as e:
     row['status']='failed';row['error']=str(e)
     try:collect(row);snapshot(row,'failure')
     except Exception as capture:row['captureError']=str(capture)
     print('FAIL '+row['id']+': '+str(e),flush=True)
    finally:
     (OUT/'results.json').write_text(json.dumps(results,indent=2));(OUT/'paste-cases.json').write_text(json.dumps(cases,indent=2));wd('DELETE','');session=None
 assert len(results)==8 and all(r.get('status')=='pass'for r in results),'One or more WebKit cells failed; see complete results'
finally:
 if clipboard:clipboard.terminate();clipboard.wait(timeout=5)
 if session:wd('DELETE','')
