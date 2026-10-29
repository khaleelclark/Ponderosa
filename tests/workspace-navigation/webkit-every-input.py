# W3C WebDriver + installed GTK clipboard, standard library only. WebKitGTK is not Safari/iOS.
import base64,json,os,pathlib,subprocess,time,urllib.request,urllib.error
OUT=pathlib.Path(os.environ.get('QUALIFICATION_DIRECTORY','/evidence')); FIX=json.loads((OUT/'fixture.json').read_text()); ROOT=os.environ.get('WEBDRIVER_ORIGIN','http://127.0.0.1:4445'); session=None; results=[]; cases=[]; clipboard=None
ELEMENT='element-6066-11e4-a52e-4f735466cecf'

def http(method,url,data=None):
 body=None if data is None else json.dumps(data).encode()
 try:
  with urllib.request.urlopen(urllib.request.Request(url,data=body,headers={'Content-Type':'application/json'},method=method),timeout=40) as response:return json.load(response)
 except urllib.error.HTTPError as e:
  payload=e.read().decode();raise RuntimeError(str(e)+' '+payload) from e

def wd(method,path,data=None):return http(method,ROOT+('/session/'+session if session else '')+path,data).get('value')
def js(script,*args):return wd('POST','/execute/sync',{'script':script,'args':list(args)})
def wait(fn,reason,seconds=15,retry_stale=True):
 end=time.monotonic()+seconds;last=None
 while time.monotonic()<end:
  try:
   value=fn()
   if value:return value
  except Exception as e:
   if not retry_stale and 'stale element reference' in str(e):raise
   last=str(e)
  time.sleep(.1)
 raise AssertionError(reason+(': '+last if last else ''))
def visible_script():return 'const visible=e=>!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=="hidden";'
def label(name):return wait(lambda:js(visible_script()+r'''return [...document.querySelectorAll('[aria-label],input,textarea,[contenteditable],[role=combobox]')].find(e=>visible(e)&&(e.getAttribute('aria-label')===arguments[0]||(e.getAttribute('aria-labelledby')||'').split(' ').some(id=>document.getElementById(id)?.textContent.trim()===arguments[0])||[...document.querySelectorAll('label')].some(l=>l.htmlFor&&l.htmlFor===e.id&&l.textContent.trim().replace(/\s*\*$/,'')===arguments[0])));''',name),'label '+name)
def button(name,role=None):
 return wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="tab"]')].findLast(e=>visible(e)&&(!arguments[1]||e.getAttribute('role')===arguments[1])&&(e.getAttribute('aria-label')===arguments[0]||e.textContent.replace(/\\s+/g,' ').trim()===arguments[0]));''',name,role),'button '+name)
def click(e):
 wait(lambda:not js('return arguments[0].disabled||arguments[0].getAttribute("aria-disabled")==="true";',e),'native action enabled',retry_stale=False)
 js('arguments[0].scrollIntoView({block:"center",inline:"center"});',e)
 wait(lambda:js('const e=arguments[0],r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(e===hit||e.contains(hit));',e),'native click target unobstructed',retry_stale=False);time.sleep(.1)
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
 return js("""const root=arguments[0];if(root.children.length!==1||root.firstElementChild.tagName!=="P")throw Error("Unexpected plain-text editor tree");const p=root.firstElementChild;if(p.childNodes.length===1&&p.firstChild.nodeName==="BR")return "";return [...p.childNodes].map(n=>{if(n.nodeType===Node.TEXT_NODE)return n.nodeValue;if(n.nodeName==="BR")return "\\n";if(n.nodeName==="SPAN"&&n.hasAttribute("data-lexical-text"))return n.textContent;throw Error("Unexpected plain-text draft node "+n.nodeName);}).join("");""",e)

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
def arm_clipboard(payload):
 global clipboard
 if os.environ.get('QUALIFICATION_DRIVER')=='chromium-mobile':
  wd('POST','/clipboard',{'text':payload});return
 if clipboard:clipboard.terminate();clipboard.wait(timeout=5)
 clipboard=subprocess.Popen(['python3','/qualification/webkit-clipboard.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 clipboard.stdin.write(payload.encode());clipboard.stdin.close();assert clipboard.stdout.readline().decode().strip()=='READY','Native GTK clipboard ready'
def open_answer(action,field):
 # Reacquire only a local opening control. Once its native click succeeds,
 # await the dialog instead of clicking the newly covered control again.
 def trigger():
  if js(visible_script()+'''return [...document.querySelectorAll('[role=dialog] textarea')].some(visible);'''):return True
  e=button(action);js('arguments[0].scrollIntoView({block:"center"});',e);wd('POST','/element/'+e[ELEMENT]+'/click',{});return True
 wait(trigger,'open current Decision dialog');wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('[role=dialog] textarea')].some(visible);'''),'Decision dialog mounted');return label(field)

def grouped(info,row):
 open_answer('Answer','Your answer');answers=[];marker=row['id']+'-decision-group'
 for index,(qid,name) in enumerate([('first','Your answer'),('second','Alternative direction'),('third','Your answer')]):
  editor=label(name)
  for ending in ['\n','\r\n']:
   payload=ending.join([marker+'-'+qid+' λ😀','second line','','TAIL_KEEP_ME']);expected=payload.replace('\r\n','\n');assert expected.count('\n')==3;arm_clipboard(payload);click(editor);chord('\ue009','a');chord('\ue003');chord('\ue009','v');paste=js('return window.qualificationPastes.at(-1);');assert paste['trusted'] and paste['text'] in [payload,expected];assert value(editor)==expected
   row.setdefault('deliveries',[]).append({'kind':'decision-group','questionId':qid,'payload':payload,'pasteEvent':paste,'exactDraft':expected})
  answers.append({'questionId':qid,'status':'answered','text':expected,'attachmentIds':[]})
  if index<2:click(button('Next'))
 click(button('Submit answers'));wait(lambda:any(marker in json.dumps(r.get('body',{})) for r in http('GET',FIX['origin']+'/api/__qualification/accepted')),'grouped answers accepted')
 cases.append({'marker':marker,'kind':'decision-group','product':row['product'],'row':row['id'],'expectedAnswers':answers,'agentId':info['agent']['id'],'decisionId':info['decision']['id'],'prefix':info['prefix']});row['checks'].append('Exact conditional decision-group');snapshot(row,'decision-group');collect(row)

def conditional(product,theme,row):
 for kind in (['chat','runtime-enum','a11y-chat','runtime-string','dm','queue','queue-chat','queue-inbox','call','call-chat','call-inbox','decision-text','decision-chat','decision-inbox','decision-other','decision-approval','decision-group','decision-notification','runtime-other','runtime-url-other','inbox','initial','long-edit'] if product=='core' else ['a11y-unpublished','chat','runtime-enum','workflow-gate','workflow-intervention','runtime-string','dm','call','call-chat','decision-text','decision-chat','decision-other','decision-approval','decision-group','decision-notification','decision-execution','runtime-other','runtime-url-other','initial','long-edit','queue','queue-chat']):
  if os.environ.get('QUALIFICATION_KINDS') and kind not in os.environ['QUALIFICATION_KINDS'].split(','):continue
  if product in ['assistant','output'] and kind in ['a11y-unpublished','workflow-gate','workflow-intervention','decision-notification','queue-chat','call-chat','decision-chat','decision-execution']:continue
  row['step']=kind+' prepare';info=http('POST',FIX['origin']+'/api/__qualification/prepare',{'product':product,'kind':kind});go(FIX['origin']+info['route'],row);accessibility(row)
  if kind in ['queue-inbox','call-inbox']:
   target=wait(lambda:js(visible_script()+"return [...document.querySelectorAll('button[aria-label]')].filter(e=>visible(e)&&e.getAttribute('aria-label')===arguments[0]&&e.closest('article')?.textContent.includes(arguments[1])).at(-1);",'Reply to Paste recipient',info['sourceTitle']),'Inbox reply target');js('arguments[0].scrollIntoView({block:"center"});arguments[0].focus();',target);chord('\ue007')
  if kind=='a11y-unpublished':
   tab=button('Executions','tab');wait(lambda:js('return arguments[0].disabled === true;',tab),'Actually disabled unpublished Executions tab');accessibility(row);snapshot(row,kind);row['checks'].append('Original #27 disabled Executions is actual named tab button');continue
  if kind=='a11y-chat':
   label('Message')
   if os.environ.get('QUALIFICATION_VIEWPORT')=='mobile':continue
   expand=js(visible_script()+'''return [...document.querySelectorAll('button[aria-label="Expand workspace header"]')].find(visible);''')
   if expand:click(expand)
   click(button('Open Browser'));separator=label('Resize browser panel');snapshot(row,'browser-separator-before-assertion');accessibility(row,enforce_tabs=False)
   before=float(js('return arguments[0].getAttribute("aria-valuenow");',separator));js('arguments[0].focus();',separator);chord('\ue014');after=wait(lambda:float(js('return arguments[0].getAttribute("aria-valuenow");',separator))!=before,'Resize keyboard changes exposed value');row['dockResize']={'before':before,'after':float(js('return arguments[0].getAttribute("aria-valuenow");',separator))};snapshot(row,'browser-separator-keyboard');click(button('Close browser panel'));row['checks'].append('Desktop dock separator numeric value and keyboard update');continue
  if kind.startswith('workflow-'):

   workflow(info,row,kind);continue
  if kind=='runtime-enum':
   choice='Allowed '+info['agent']['id']+' λ😀';click(label('Provider choice'));click(button(choice,'option'));click(button('Submit'));wait(lambda:any(r.get('body',{}).get('content',{}).get('reply')==choice for r in http('GET',FIX['origin']+'/api/__qualification/accepted')),'Schema enum value accepted');cases.append({'marker':row['id']+'-runtime-enum','kind':kind,'row':row['id'],'product':product,'agentId':info['agent']['id'],'decisionId':info['decision']['id'],'prefix':info['prefix'],'expected':choice});row['checks'].append('Schema-constrained provider enum');snapshot(row,kind);continue
  if kind=='decision-group':grouped(info,row);continue
  if kind=='inbox':editor=label('Message')
  elif kind=='long-edit':
   editor=label('Message');click(editor);arm_clipboard('Seed long paste\n'+'x'*10001);chord('\ue009','v');click(button('View or edit'));editor=wait(lambda:js('return document.querySelector("[role=dialog] textarea:not([aria-hidden])");'),'long paste editor')
  elif kind=='initial':
   if product!='core':
    label('Message')
    expand=js(visible_script()+'''return [...document.querySelectorAll('button[aria-label="Expand workspace header"]')].filter(visible).at(-1);''')
    if expand:click(expand)
    click(button('Agent Chat Actions'));click(button('Create Agent'))
   editor=label('Initial message (optional)')
  elif kind.startswith('queue'):
   edit=wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('button[aria-label]')].find(e=>visible(e)&&e.getAttribute('aria-label').startsWith('Edit queued message '));'''),'queued edit action');click(edit);editor=wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('textarea[aria-label]')].find(e=>visible(e)&&e.getAttribute('aria-label').startsWith('Edit queued message '));'''),'current queued edit field')
  elif kind.startswith('call'):
   click(button('Voice options'));click(wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('[role=menuitem]')].find(e=>visible(e)&&e.textContent.trim().startsWith('Voice call'));'''),'Voice call'));click(button('Transcript & typing'));editor=label('Your next turn')
  elif kind=='runtime-string':editor=label('Provider reply')
  elif kind.startswith('runtime-'):click(button('Other'));editor=label('Tell the Agent what you want instead')
  elif kind.startswith('decision'):
   if kind=='decision-notification':
    if os.environ.get('QUALIFICATION_VIEWPORT')=='mobile':
     label('Message');click(button('Open workspace navigation'))
    click(wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('button[aria-label]')].find(e=>visible(e)&&e.getAttribute('aria-label').startsWith(arguments[0]));''','Notifications' if product=='core' else 'Branches notifications'),'Notifications'))
   editor=open_answer('Answer' if kind in ['decision-text','decision-notification','decision-chat','decision-inbox','decision-execution'] else 'Something Else','Your answer' if kind in ['decision-text','decision-notification','decision-chat','decision-inbox','decision-execution'] else 'Alternative direction')
  else:editor=label('Message')
  if kind=='dm' and os.environ.get('QUALIFICATION_VIEWPORT')=='mobile':
   expand=js(visible_script()+'''return [...document.querySelectorAll('button[aria-label="Expand workspace header"]')].find(visible);''')
   if expand:click(expand)
   wait(lambda:js(visible_script()+'''return [...document.querySelectorAll('[role=tablist]')].some(visible);'''),'Actual expanded mobile tablist mounted')
  accessibility(row)
  for ending in ['\n','\r\n']:
   # Each saved conditional owner is consumed once; retain both native deliveries in draft, submit final CRLF case.
   marker=row['id']+'-'+kind;payload=ending.join([marker+' λ😀','second line','','TAIL_KEEP_ME']);expected=payload.replace('\r\n','\n');assert expected.count('\n')==3,'Real multiline payload required';arm_clipboard(payload);click(editor);chord('\ue009','a');chord('\ue003');chord('\ue009','v');paste=js('return window.qualificationPastes.at(-1);');assert paste['trusted'] and paste['text'] in [payload,expected]
   if kind in ['chat','dm','inbox']:expected=paste['text']
   assert (draft(editor) if kind in ['chat','dm','inbox'] else value(editor))==expected,('conditional draft',kind)
   row.setdefault('deliveries',[]).append({'kind':kind,'payload':payload,'pasteEvent':paste,'exactDraft':expected})
  if kind=='long-edit':click(button('Save'));click(button('Send message'))
  elif kind=='inbox':
   target=wait(lambda:js(visible_script()+"return [...document.querySelectorAll('button[aria-label=\"Reply to Paste recipient\"]')].filter(e=>visible(e)&&e.closest('article')?.textContent.includes(arguments[0])).at(-1);",info['sourceTitle']),'latest Inbox reply');js('arguments[0].scrollIntoView({block:"center"});arguments[0].focus();',target);chord('\ue007');click(button('Send message'))
  elif kind in ['chat','dm']:click(button('Send message'))
  elif kind=='initial':
   set_field(label('Name'),'Created paste recipient');click(button('Create Agent'))
  elif kind.startswith('queue'):click(button('Save'))
  elif kind=='runtime-string':click(button('Submit'))
  elif kind.startswith('runtime-'):click(button('Send to Agent'))
  elif kind.startswith('call'):wait(lambda:not js('return arguments[0].disabled;',button('Send turn')),'call typing ready');click(button('Send turn'))
  else:click(button('Send Response'))
  wait(lambda:any(marker in json.dumps(r.get('body',{})) for r in http('GET',FIX['origin']+'/api/__qualification/accepted')),'conditional accepted')
  cases.append({'marker':marker,'product':product,'kind':kind,'row':row['id'],'payload':payload,'expected':expected,'agentId':info['agent']['id'] if kind!='initial' else None,'agentHandle':info['agent']['handle'],'decisionId':info.get('decision',{}).get('id'),'prefix':info['prefix'],'pasteEvent':paste});row['checks'].append('Exact conditional '+kind);snapshot(row,kind);collect(row)

def paste_value(editor,marker,row,kind):
 for ending in ['\n','\r\n']:
  payload=ending.join([marker+' λ😀','second line','','TAIL_KEEP_ME']);expected=payload.replace('\r\n','\n');arm_clipboard(payload);click(editor);chord('\ue009','a');chord('\ue003');chord('\ue009','v');paste=js('return window.qualificationPastes.at(-1);');assert paste['trusted'] and paste['text'] in [payload,expected];assert value(editor)==expected,('Complete adjacent field',kind,value(editor),expected)
  row.setdefault('deliveries',[]).append({'kind':kind,'payload':payload,'pasteEvent':paste,'exactDraft':expected})
 return expected

def workflow(info,row,kind):
 marker=row['id']+'-'+kind
 if kind=='workflow-gate':
  expected=paste_value(label('Proposed result'),marker,row,kind);click(button('Approve edited text'));expected_values={'output':expected}
 else:
  click(button('Mark Observed Result'));expected=paste_value(label('Observed output'),marker,row,kind);reason=paste_value(label('Reason for this decision'),marker+'-reason',row,kind+'-reason');click(wait(lambda:js(visible_script()+r"""return [...document.querySelectorAll('label')].find(e=>visible(e)&&e.textContent.trim()==="I have reconciled the earlier attempt’s effects")?.querySelector('input');"""),'Actual reconciliation switch'));click(button('Apply decision'));expected_values={'output':expected,'reason':reason}
 wait(lambda:any(marker in json.dumps(r.get('body',{})) for r in http('GET',FIX['origin']+'/api/__qualification/accepted')),'workflow accepted')
 cases.append({'marker':marker,'kind':kind,'row':row['id'],'product':row['product'],'executionId':info['executionId'],'gateId':info.get('gateId'),'expectedValues':expected_values});row['checks'].append('Exact adjacent '+kind);snapshot(row,kind);collect(row)

def accessibility(row,enforce_tabs=True):
 # Assert actual mounted tab ownership, not just absence of an axe finding.
 result=js("""const visible=e=>e.getClientRects().length>0;return {tabs:[...document.querySelectorAll('[role=tablist]')].filter(visible).map(list=>({label:list.getAttribute('aria-label'),invalid:[...list.querySelectorAll('button,input,[tabindex]')].filter(e=>visible(e)&&!e.closest('[role=tab]')&&e.getAttribute('tabindex')!=='-1').map(e=>e.outerHTML),tabs:[...list.querySelectorAll('[role=tab]')].map(e=>({id:e.id,tag:e.tagName,disabled:e.getAttribute('aria-disabled'),nativeDisabled:Boolean(e.disabled),name:e.getAttribute('aria-label')||e.textContent,selected:e.getAttribute('aria-selected')}))})),separators:[...document.querySelectorAll('[role=separator][tabindex]')].filter(visible).map(e=>({label:e.getAttribute('aria-label'),now:e.getAttribute('aria-valuenow'),min:e.getAttribute('aria-valuemin'),max:e.getAttribute('aria-valuemax')}))};""")
 row.setdefault('accessibilitySnapshots',[]).append(result)
 assert not enforce_tabs or all(not t['invalid'] for t in result['tabs']),'Interactive non-tab descendant in tablist'
 for tabs in result['tabs']:
  if tabs['label']=='Branch views':
   assert sorted(t['id'] for t in tabs['tabs'])==sorted('branch-'+name+'-tab' for name in ['workflow','executions','chats','settings']),'Four Branch tab roles including disabled Executions'
   assert all(t['tag']=='BUTTON' and t['name'] for t in tabs['tabs']),'Actual named tab buttons, no disabled wrapper substitute'
 assert all(s['now'] is not None and s['now'].replace('.','',1).isdigit() for s in result['separators']),'Focusable separator requires numeric current value'

try:
 wait(lambda:http('GET',ROOT+'/status').get('value',{}).get('ready'),'WebDriver ready')
 for product in os.environ.get('QUALIFICATION_PRODUCTS','core,branches').split(','):
  for theme in os.environ.get('QUALIFICATION_THEMES','light,dark').split(','):
   row={'id':product+'-'+theme,'product':product,'theme':theme,'checks':[],'pageErrors':[]};results.append(row)
   result=http('POST',ROOT+'/session',{'capabilities':{'alwaysMatch':{'browserName':'MiniBrowser'}}})['value'];session=result['sessionId'];row['engine']=result['capabilities']
   try:
    wd('POST','/window/rect',{'width':390 if os.environ.get('QUALIFICATION_VIEWPORT')=='mobile' else 1440,'height':844 if os.environ.get('QUALIFICATION_VIEWPORT')=='mobile' else 1000});go(FIX['origin']);js('localStorage.setItem("ponderosa-color-mode",arguments[0]);',theme);row['viewport']=js('return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,userAgent:navigator.userAgent};');accessibility(row);conditional(product,theme,row);assert not row['pageErrors'];row['status']='pass';print('PASS '+row['id'],flush=True)
   except Exception as e:
    row['status']='failed';row['error']=repr(e)
    try:collect(row);snapshot(row,'failure')
    except Exception as capture:row['captureError']=str(capture)
    print('FAIL '+row['id']+': '+str(e),flush=True)
   finally:
    (OUT/'results.json').write_text(json.dumps(results,indent=2));(OUT/'paste-cases.json').write_text(json.dumps(cases,indent=2));wd('DELETE','');session=None
   if row.get('status')!='pass':raise AssertionError(row['error'])
 assert all(r.get('status')=='pass'for r in results),'Conditional flow failures retained'
finally:
 if clipboard:clipboard.terminate();clipboard.wait(timeout=5)
 if session:wd('DELETE','')
