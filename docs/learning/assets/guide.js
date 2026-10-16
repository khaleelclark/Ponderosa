/* Local-only enhancement. Content and ordinary anchor navigation work without JS. */
(() => {
  document.body.classList.add('pg-enhanced');
  const root = document.documentElement;
  const topics = [...document.querySelectorAll('.pg-topic')];
  const navLinks = [...document.querySelectorAll('.pg-nav-group > a')];
  const menu = document.querySelector('#pg-menu');
  const toc = document.querySelector('#pg-toc');
  const current = document.querySelector('#pg-current');
  const theme = document.querySelector('#pg-theme');
  const dialog = document.querySelector('#pg-search-dialog');
  const query = document.querySelector('#pg-query');
  const results = document.querySelector('#pg-results');
  const count = document.querySelector('#pg-search-count');
  const index = topics.map(section => ({section, id:section.id, title:section.dataset.title, text:section.textContent.replace(/\s+/g,' ').trim()}));
  let timer;
  function closeMenu() {toc.classList.remove('pg-open');menu.setAttribute('aria-expanded','false');}
  menu.addEventListener('click',() => {const open=menu.getAttribute('aria-expanded')!=='true';toc.classList.toggle('pg-open',open);menu.setAttribute('aria-expanded',String(open));});
  toc.addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
  function setTheme(mode) {root.dataset.theme=mode;theme.textContent=mode==='dark'?'Light theme':'Dark theme';theme.setAttribute('aria-label',`Switch to ${mode==='dark'?'light':'dark'} theme`);}
  try {const saved=localStorage.getItem('ponderosa-guide-theme');if(saved==='light'||saved==='dark')setTheme(saved);}catch{}
  theme.addEventListener('click',()=>{const mode=root.dataset.theme==='dark'?'light':'dark';setTheme(mode);try{localStorage.setItem('ponderosa-guide-theme',mode);}catch{}});
  function activeSection() {
    const chosen=[...topics].reverse().find(section=>section.getBoundingClientRect().top<150)||topics[0];
    current.textContent=chosen.dataset.title;
    navLinks.forEach(link=>{if(link.hash===`#${chosen.id}`)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});
  }
  let scheduled=false;
  window.addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>{activeSection();scheduled=false;});}},{passive:true});
  function revealHash() {
    const id=decodeURIComponent(location.hash.slice(1));
    if(!id)return;
    const target=document.getElementById(id);
    if(target){let parent=target.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}}
  }
  window.addEventListener('hashchange',()=>{revealHash();closeMenu();activeSection();});
  function search() {
    const value=query.value.trim().toLocaleLowerCase();
    const words=value.split(/\s+/).filter(Boolean);
    results.replaceChildren();
    const matches=words.length?index.filter(item=>words.every(word=>item.text.toLocaleLowerCase().includes(word))):[];
    count.textContent=words.length?`${matches.length} topic${matches.length===1?'':'s'} found`:'Type to search all topics, including implementation details.';
    for(const item of matches) {
      const link=document.createElement('a');link.href=`#${item.id}`;link.className='pg-search-result';
      const title=document.createElement('strong');title.textContent=item.title;
      const snippet=document.createElement('span');const pos=item.text.toLocaleLowerCase().indexOf(words[0]);const start=Math.max(0,pos-65);snippet.textContent=(start?'…':'')+item.text.slice(start,start+210)+'…';
      link.append(title,snippet);
      link.addEventListener('click',()=>{dialog.close();item.section.querySelectorAll('details').forEach(detail=>{if(words.every(word=>detail.textContent.toLocaleLowerCase().includes(word)))detail.open=true;});closeMenu();item.section.setAttribute('tabindex','-1');requestAnimationFrame(()=>item.section.focus({preventScroll:true}));});
      results.append(link);
    }
    if(words.length&&!matches.length){const p=document.createElement('p');p.textContent='No matching topic. Try one concept, such as fence, attachment, or compaction.';results.append(p);}
  }
  function openSearch(){closeMenu();dialog.showModal();search();query.focus();}
  document.querySelector('#pg-search-open').addEventListener('click',openSearch);
  document.querySelector('#pg-search-close').addEventListener('click',()=>dialog.close());
  query.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(search,80);});
  document.addEventListener('keydown',event=>{const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)||document.activeElement?.isContentEditable;if(event.key==='/'&&!typing&&!dialog.open){event.preventDefault();openSearch();}if(event.key==='Escape'){if(dialog.open){event.preventDefault();dialog.close();}const wasOpen=menu.getAttribute('aria-expanded')==='true';closeMenu();if(wasOpen)menu.focus();}});
  window.addEventListener('resize',()=>{if(innerWidth>700)closeMenu();});
  revealHash();activeSection();
})();
