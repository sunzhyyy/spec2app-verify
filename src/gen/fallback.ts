import type { ParsedGeneration } from './provider';

/** Saved examples used ONLY after an explicit user action when the live provider fails. Never labelled live. */
const html = (title: string, body: string) =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n${body}\n<script src="script.js"></script>\n</body>\n</html>`;

const baseCss = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#f6f7fb;color:#1c1f2a}main{max-width:720px;margin:0 auto;padding:24px}h1{margin:0 0 16px}input,select,button,textarea{font:inherit;padding:8px 10px;border:1px solid #c9ccd8;border-radius:6px}button{background:#3346d3;color:#fff;border-color:#3346d3;cursor:pointer}form{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}`;

export const FALLBACK_EXAMPLES: Record<'todo' | 'mortgage' | 'portfolio', ParsedGeneration> = {
  todo: {
    title: 'Todo Board (saved example)',
    summary: 'Saved fallback todo board with priorities and due dates.',
    generationNotes: 'Saved fallback example – no live model call.',
    readme: '# Todo Board\nSaved fallback example. Add, complete and delete tasks.',
    stylesCss: `${baseCss}ul{list-style:none;padding:0}li{display:flex;gap:8px;align-items:center;background:#fff;padding:10px;border-radius:6px;margin-bottom:6px}li.done span{text-decoration:line-through;opacity:.6}.p-high{color:#b42318}`,
    indexHtml: html('Todo Board', `<main><h1>Todo Board</h1><form id="f"><input id="t" required placeholder="Task"><select id="p"><option>low</option><option>medium</option><option>high</option></select><input id="d" type="date"><button>Add</button></form><ul id="list"></ul></main>`),
    scriptJs: `let tasks=[];const list=document.getElementById('list');
function render(){list.innerHTML='';tasks.forEach((t,i)=>{const li=document.createElement('li');if(t.done)li.className='done';li.innerHTML='<input type="checkbox" '+(t.done?'checked':'')+'><span class="p-'+t.p+'"></span><small></small><button type="button">Delete</button>';li.querySelector('span').textContent=t.text+' ['+t.p+']';li.querySelector('small').textContent=t.d||'';li.querySelector('input').onchange=()=>{t.done=!t.done;save()};li.querySelector('button').onclick=()=>{tasks.splice(i,1);save()};list.appendChild(li)})}
function save(){window.AppStorage.save(tasks);render()}
document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();const t=document.getElementById('t');tasks.push({text:t.value,p:document.getElementById('p').value,d:document.getElementById('d').value,done:false});t.value='';save()});
(async()=>{tasks=(await window.AppStorage.load())||[];render()})();`,
  },
  mortgage: {
    title: 'Mortgage Calculator (saved example)',
    summary: 'Saved fallback mortgage calculator.',
    generationNotes: 'Saved fallback example – no live model call.',
    readme: '# Mortgage Calculator\nSaved fallback example.',
    stylesCss: `${baseCss}label{display:block;margin:10px 0}output{display:block;font-size:2rem;margin-top:16px}`,
    indexHtml: html('Mortgage Calculator', `<main><h1>Mortgage Calculator</h1><label>Loan amount <input id="a" type="number" value="300000"></label><label>Annual interest rate % <input id="r" type="number" step="0.01" value="6"></label><label>Loan term (years) <input id="y" type="number" value="30"></label><output id="o"></output></main>`),
    scriptJs: `const $=id=>document.getElementById(id);function calc(){const P=+$('a').value,r=+$('r').value/1200,n=+$('y').value*12;const m=r?P*r/(1-Math.pow(1+r,-n)):P/n;$('o').textContent=isFinite(m)?'Monthly payment: $'+m.toFixed(2):'Enter valid values';window.AppStorage.save({a:$('a').value,r:$('r').value,y:$('y').value})}
['a','r','y'].forEach(i=>$(i).addEventListener('input',calc));(async()=>{const s=await window.AppStorage.load();if(s){$('a').value=s.a;$('r').value=s.r;$('y').value=s.y}calc()})();`,
  },
  portfolio: {
    title: 'Portfolio (saved example)',
    summary: 'Saved fallback personal portfolio.',
    generationNotes: 'Saved fallback example – no live model call.',
    readme: '# Portfolio\nSaved fallback example.',
    stylesCss: `${baseCss}.hero{padding:40px 0}.skills span{display:inline-block;background:#e4e7ff;padding:4px 10px;border-radius:99px;margin:3px}.proj{background:#fff;padding:12px;border-radius:6px;margin:6px 0;cursor:pointer}.proj p{display:none}.proj.open p{display:block}`,
    indexHtml: html('Portfolio', `<main><section class="hero"><h1>Alex Doe</h1><p>Front-end developer.</p></section><h2>Projects</h2><div class="proj"><strong>Weather app</strong><p>Forecast dashboard.</p></div><div class="proj"><strong>Recipe finder</strong><p>Search recipes by ingredient.</p></div><h2>Skills</h2><div class="skills"><span>HTML</span><span>CSS</span><span>JavaScript</span></div><h2>Contact</h2><form id="c"><input id="n" required placeholder="Name"><input id="e" type="email" required placeholder="Email"><button>Send</button></form><p id="m" role="status"></p></main>`),
    scriptJs: `document.querySelectorAll('.proj').forEach(p=>p.onclick=()=>p.classList.toggle('open'));document.getElementById('c').addEventListener('submit',e=>{e.preventDefault();document.getElementById('m').textContent='Thanks, '+document.getElementById('n').value+'! Message recorded locally.';window.AppStorage.save({last:document.getElementById('n').value})});`,
  },
};
