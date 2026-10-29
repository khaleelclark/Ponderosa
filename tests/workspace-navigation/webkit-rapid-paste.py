# W3C WebDriver + installed GTK clipboard, standard library only. WebKitGTK is not Safari/iOS.
import base64,json,os,pathlib,subprocess,time,urllib.request,urllib.error
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
def rapid(surface,theme,row):
 url=FIX['normalUrl'] if surface=='core' else FIX['url'] if surface=='branches' else FIX['origin']+('/assistant' if surface=='assistant' else FIX['assistant']['app']['url'])
 go(url,row);editor=label('Message');click(editor)
 for index in range(4):
  ending='\n' if index%2==0 else '\r\n';marker=row['id']+'-'+str(index);payload=ending.join([marker+' λ😀','second line','','TAIL_KEEP_ME']);normalized=payload.replace('\r\n','\n')
  if index==0:arm_clipboard(payload)
  chord('\ue009','a');chord('\ue003');chord('\ue009','v')
  paste=js('return window.qualificationPastes.at(-1);');assert paste['trusted'] and paste['text']==normalized,('browser paste',paste)
  paste['rawPayloadExact']=paste['text']==payload;row['pasteDom']=js('return {html:arguments[0].innerHTML,text:arguments[0].textContent};',editor)
  assert draft(editor)==normalized,('exact rapid pasted draft',row['pasteDom'],normalized)
  chord('\ue008','\ue007');keys(editor,'SHIFT_TAIL');expected=normalized+'\nSHIFT_TAIL';assert draft(editor)==expected
  # Prepare next native clipboard before send; no post-send settlement delay or screenshot.
  if index<3:
   nextEnding='\r\n' if (index+1)%2 else '\n';arm_clipboard(nextEnding.join([row['id']+'-'+str(index+1)+' λ😀','second line','','TAIL_KEEP_ME']))
  send=button('Send message');wd('POST','/element/'+send[ELEMENT]+'/click',{})
  wait(lambda:not js('return arguments[0].getAttribute("aria-disabled")==="true"||arguments[0].getAttribute("contenteditable")==="false";',editor) and not js('return arguments[0].textContent.includes(arguments[1]);',editor,marker) and marker in text(),'submitted draft retired and editor editable')
  cases.append({'marker':marker,'product':surface,'row':row['id'],'payload':payload,'expected':expected,'pasteEvent':paste});row['checks'].append('Rapid exact paste '+str(index))
 # Drain only after the complete rapid sequence, never between send and next paste.
 wait(lambda:all(any(c['marker'] in json.dumps(r.get('body',{})) for r in http('GET',FIX['origin']+'/api/__qualification/accepted')) for c in cases if c['row']==row['id']),'sequence accepted by real API',30)
 snapshot(row,'rapid-complete');collect(row)
def call_label(row):
 wd('POST','/window/rect',{'width':390,'height':844});go(FIX['url'],row);click(button('Voice options'));click(wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('[role=menuitem]')].find(e=>visible(e)&&e.textContent.trim().startsWith('Voice call'));'''),'Voice call entry'))
 click(button('Transcript & typing'));turn=label('Your next turn');click(turn);keys(turn,'Unsent native label qualification λ😀');wait(lambda:'Send or clear your draft before starting a call.' in text(),'native call draft')
 def geometry():return js("""const t=arguments[0],l=document.querySelector('label[for="'+t.id+'"]'),select=document.querySelector('[role=dialog] select'),sl=select&&document.querySelector('label[for="'+select.id+'"]');const info=(e)=>e&&({rect:e.getBoundingClientRect().toJSON(),transform:getComputedStyle(e).transform,shrink:e.getAttribute('data-shrink'),text:e.textContent});return {textarea:info(t),label:info(l),select:info(select),selectLabel:info(sl)};""",turn)
 row['callLabelInitial']=geometry();snapshot(row,'call-label-initial');assert row['callLabelInitial']['label']['rect']['bottom']<=row['callLabelInitial']['textarea']['rect']['top'],'Immediate textarea label clear of native text'
 wd('POST','/execute/async',{'script':"const done=arguments[arguments.length-1];Promise.all([...document.querySelectorAll('[role=dialog] label')].flatMap(e=>e.getAnimations()).map(a=>a.finished.catch(()=>{}))).then(()=>requestAnimationFrame(()=>requestAnimationFrame(done)));",'args':[]})
 row['callLabelSettled']=geometry();snapshot(row,'call-label-settled');assert row['callLabelSettled']['label']['rect']['bottom']<=row['callLabelSettled']['textarea']['rect']['top'],'Settled textarea label clear of native text'
 click(button('End call'));row['checks'].append('Native call textarea label geometry after CSS animation completion')

try:
 wait(lambda:http('GET',ROOT+'/status').get('value',{}).get('ready'),'WebDriver ready')
 for surface in (['branches'] if os.environ.get('QUALIFICATION_MODE')=='label-only' else ['core','branches','assistant','output']):
  for theme in ['light','dark']:
   row={'id':surface+'-'+theme,'product':surface,'theme':theme,'checks':[],'pageErrors':[]};results.append(row)
   result=http('POST',ROOT+'/session',{'capabilities':{'alwaysMatch':{'browserName':'MiniBrowser'}}})['value'];session=result['sessionId'];row['engine']=result['capabilities']
   try:
    wd('POST','/window/rect',{'width':1440,'height':1000});go(FIX['origin']);js('localStorage.setItem("ponderosa-color-mode",arguments[0]);',theme)
    row['viewport']=js('return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,userAgent:navigator.userAgent};');
    if os.environ.get('QUALIFICATION_MODE')!='label-only':rapid(surface,theme,row)

    if surface=='branches':call_label(row)
    assert not row['pageErrors'];row['status']='pass';print('PASS '+row['id'],flush=True)
   except Exception as e:
    row['status']='failed';row['error']=str(e)
    try:collect(row);snapshot(row,'failure')
    except Exception as capture:row['captureError']=str(capture)
    print('FAIL '+row['id']+': '+str(e),flush=True)
   finally:
    (OUT/'results.json').write_text(json.dumps(results,indent=2));(OUT/'paste-cases.json').write_text(json.dumps(cases,indent=2));wd('DELETE','');session=None
 assert all(r.get('status')=='pass'for r in results),'Rapid flow failures retained'
finally:
 if clipboard:clipboard.terminate();clipboard.wait(timeout=5)
 if session:wd('DELETE','')
