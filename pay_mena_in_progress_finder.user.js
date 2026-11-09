// ==UserScript==
// @name         pay_mena In Progress Finder
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Список тикетов в статусе In progress: кто последним работал с тикетом (Admin username), Inside comment, даты; Excel с листами Waiting for / pay_mena / pay_mena_antifraud / pay_support_mena / pay_cm_mena / Остальные
// @match        *://th-managment.com/*
// @match        *://*.th-managment.com/*
// @match        *://webmanegment.com/*
// @match        *://*.webmanegment.com/*
// @require      https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js
// @grant        GM_addStyle
// @run-at       document-idle
// @homepageURL  https://github.com/partenkoEgor/double_mistake_finder
// @updateURL    https://raw.githubusercontent.com/partenkoEgor/double_mistake_finder/main/pay_mena_in_progress_finder.user.js
// @downloadURL  https://raw.githubusercontent.com/partenkoEgor/double_mistake_finder/main/pay_mena_in_progress_finder.user.js
// ==/UserScript==
(function(){'use strict';

// ════════════════════════════════════════════════════
// DETECTOR — чистая логика без DOM (тестируется в Node)
// ════════════════════════════════════════════════════
var Detector = (function(){
  function norm(s){
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function parseDate(s){
    var d = new Date(String(s || '').replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }
  function str(v){ return v == null ? '' : String(v).trim(); }

  // Ответ /paymentsupporthistory (resp.data) → нормализованные строки, отсортированные по дате.
  // Поля (колонки истории):
  //   nameExternalStatus  "External status"  — Approved (M) / Sent for processing (M) / In progress (M)
  //   nameInternalStatus  "Internal status"  — Customer provided additional info / Awaiting response from PS
  //   commentSupport      "Inside comment"
  //   adminProcessedLogin "Admin username",  adminProcessedName — ФИО
  function normalizeHistory(data){
    var rows = (data || []).map(function(r, idx){
      return {
        idx: idx,
        date: str(r.dateEdit),
        admin: str(r.adminProcessedLogin),
        adminName: str(r.adminProcessedName),
        status: str(r.nameExternalStatus),
        internalStatus: str(r.nameInternalStatus),
        comment: str(r.commentSupport),
        // поля тикета, которые история повторяет в каждой строке (нужны для списка ID)
        userId: str(r.idUser),
        agent: str(r.nameAgent),
        subagent: str(r.nameSubagent),
        department: str(r.nameDepartment),
        ticketType: str(r.requestTypeName)   // "Ticket type", напр. "BT M"
      };
    });
    rows.sort(function(a, b){
      var da = parseDate(a.date), db = parseDate(b.date);
      var diff = (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
      return diff || (a.idx - b.idx);
    });
    // API иногда отдает одну и ту же запись дважды
    var seen = {};
    return rows.filter(function(r){
      var k = r.date + '|' + r.status + '|' + r.internalStatus + '|' + r.admin + '|' + r.comment;
      if(seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  // значение поля тикета из последней строки истории, где оно заполнено
  function lastFilled(rows, key){
    for(var i = rows.length - 1; i >= 0; i--) if(rows[i][key]) return rows[i][key];
    return '';
  }

  // У каждого из 4 типов тикета свой статус In progress (id 2, 13, 97, 240),
  // но названия у всех «In progress» или «In progress (M)».
  function isInProgress(status){
    return /^in progress\b/.test(norm(status));
  }

  // Берём самую свежую строку истории (как «В работе у» в Team Helper) —
  // её Admin username и Inside comment.
  function analyzeInProgress(data){
    var rows = normalizeHistory(data);
    var last = rows.length ? rows[rows.length - 1] : null;
    if(!last) return null;
    // поля тикета — из последней строки, где они заполнены
    function pick(key){ return lastFilled(rows, key); }
    return {
      firstDate: rows[0].date,   // самая ранняя строка истории — запасной вариант даты создания
      isInProgress: isInProgress(last.status),
      status: last.status,
      internalStatus: last.internalStatus,
      date: last.date,
      admin: last.admin,
      adminName: last.adminName,
      comment: last.comment,
      userId: pick('userId'),
      ticketType: pick('ticketType'),
      agent: pick('agent'),
      subagent: pick('subagent'),
      department: pick('department')
    };
  }

  // Лист Excel для тикета In progress:
  //   'waiting'          — в Inside comment есть «waiting for» (регистр не важен), кто бы ни был админ;
  //   'pay_mena' / 'pay_mena_antifraud' / 'pay_support_mena' / 'pay_cm_mena' — по Admin username <префикс>_<номер>;
  //   'other'            — все остальные (в том числе пустой Admin username).
  var IP_GROUPS = [
    {key:'pay_mena',         re:/^pay_mena_\d+$/i},
    {key:'pay_mena_antifraud', re:/^pay_mena_antifraud_\d+$/i},
    {key:'pay_support_mena', re:/^pay_support_mena_\d+$/i},
    {key:'pay_cm_mena',      re:/^pay_cm_mena_\d+$/i}
  ];
  function inProgressGroup(admin, comment){
    if(norm(comment).indexOf('waiting for') !== -1) return 'waiting';
    var login = str(admin);
    for(var i = 0; i < IP_GROUPS.length; i++) if(IP_GROUPS[i].re.test(login)) return IP_GROUPS[i].key;
    return 'other';
  }

  return {
    norm: norm, normalizeHistory: normalizeHistory, isInProgress: isInProgress,
    analyzeInProgress: analyzeInProgress, inProgressGroup: inProgressGroup
  };
})();

// Node (тесты): отдаём детектор и не трогаем DOM
if(typeof module !== 'undefined' && module.exports){ module.exports = Detector; return; }

// не запускаться во фреймах и не инжектиться дважды
if(window.top !== window.self) return;
if(window.__pm_ipf_loaded) return;
window.__pm_ipf_loaded = true;

// ════════════════════════════════════════════════════
// КОНФИГ
// ════════════════════════════════════════════════════
var VERSION       = '1.0.0';
var DELAY_MIN     = 200;
var DELAY_MAX     = 600;
var DELAY_STEP    = 50;
var MAX_RETRIES   = 5;
var POLL_INTERVAL = 800;
var POLL_MAX      = 8;
var LIST_RETRIES  = 8;      // повторов страницы списка при сбое/пустом ответе
var LIST_RETRY_BASE_MS = 3000;
var PAGE_WAIT_MS  = 600;
var DEFAULT_THREADS = 3;   // параллельных запросов истории (1–5)

// ════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════
var state = {
  running:false, source:'', total:0, done:0, skipped:0, currentPage:1,
  processedIds:{}, found:[], startTime:0, _delay:DELAY_MIN, _finishing:false
};
var _listUrl = null, _listPayload = null;
var _keepaliveTimer = null, _speedTimer = null;

// ════════════════════════════════════════════════════
// УТИЛИТЫ
// ════════════════════════════════════════════════════
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function getHeaders(json){
  var h = {'X-Requested-With':'XMLHttpRequest','Accept':'application/json'};
  h['Content-Type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
  var csrf = document.head.querySelector('meta[name="csrf-token"]');
  if(csrf) h['X-CSRF-TOKEN'] = csrf.getAttribute('content');
  return h;
}
function adaptDelay(ok){
  if(ok) state._delay = Math.max(DELAY_MIN, state._delay - DELAY_STEP);
  else   state._delay = Math.min(DELAY_MAX, state._delay + DELAY_STEP * 2);
}
function parseIds(text){
  var seen = {}, out = [];
  (String(text || '').match(/\d{5,}/g) || []).forEach(function(id){
    if(!seen[id]){ seen[id] = 1; out.push(id); }
  });
  return out;
}
function startKeepalive(){
  stopKeepalive();
  _keepaliveTimer = setInterval(function(){
    if(!state.running) return;
    fetch('/admin/backoffice', {credentials:'include', method:'GET', cache:'no-store'}).catch(function(){});
  }, 3 * 60 * 1000);
}
function stopKeepalive(){ if(_keepaliveTimer){ clearInterval(_keepaliveTimer); _keepaliveTimer = null; } }

// ════════════════════════════════════════════════════
// INTERCEPTOR — ловим запрос списка после APPLY
// ════════════════════════════════════════════════════
// Тело запроса списка тикетов. Встречаются два вида:
//   Payment Support: {page, perPage, dateFrom, idTicket, externalStatus, ...}
//   Reporter:        {numberPage, dateFrom, ...}
function _isListBody(b){
  return b && typeof b === 'object' && typeof b.dateFrom !== 'undefined' &&
    (typeof b.page !== 'undefined' || typeof b.numberPage !== 'undefined');
}
// Ответ списка: {success, data:[{idTicket,...}], otherData:{hasMore}} или старый {is_polling, data}
function _isListResp(r){
  return r && (typeof r.is_polling !== 'undefined' || (Array.isArray(r.data) && (r.otherData || r.success)));
}
function _pageKey(payload){ return typeof payload.page !== 'undefined' ? 'page' : 'numberPage'; }
function _applyCapture(url, payload){
  if(state.running) return; // наши собственные запросы страниц во время сбора не перехватываем
  _listUrl = url;
  _listPayload = JSON.parse(JSON.stringify(payload));
  console.log('%c[IPF ' + VERSION + '] ✅ Список перехвачен', 'color:#3fa;font-weight:bold');
  updateApplyState();
}
(function(){
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this._ipf_m = m; this._ipf_u = u; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body){
    var self = this;
    if(this._ipf_m === 'POST' && body){
      try{
        var p = typeof body === 'string' ? JSON.parse(body) : body;
        if(_isListBody(p)){
          self.addEventListener('load', function(){
            try{
              var r = JSON.parse(self.responseText);
              if(_isListResp(r)) _applyCapture(self.responseURL || self._ipf_u, p);
            }catch(e){}
          });
        }
      }catch(e){}
    }
    return _send.apply(this, arguments);
  };
})();
(function(){
  var _orig = window.fetch;
  window.fetch = function(url, opts){
    var res = _orig.apply(this, arguments);
    if(opts && opts.method === 'POST' && opts.body){
      try{
        var p = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
        if(_isListBody(p)){
          res.then(function(r){
            r.clone().json().then(function(d){
              if(_isListResp(d)) _applyCapture(r.url || (typeof url === 'string' ? url : ''), p);
            }).catch(function(){});
          }).catch(function(){});
        }
      }catch(e){}
    }
    return res;
  };
})();

// ════════════════════════════════════════════════════
// CSS
// ════════════════════════════════════════════════════
GM_addStyle(`
/* Кнопка-«таблетка» как у Bulk Approve BETA; левый нижний угол, над кнопкой Double Mistakes */
#ipf-fab{position:fixed;left:16px;bottom:132px;z-index:2147483647;display:flex;align-items:center;gap:7px;padding:8px 14px;border-radius:999px;background:rgba(12,18,35,.9);border:1px solid rgba(90,170,255,.5);color:#9cc9ff;font:600 13px system-ui,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);user-select:none;}
#ipf-fab .dot{width:7px;height:7px;border-radius:50%;background:#5aa9ff;}
#ipf-fab.running .dot{animation:ipfpulse 1.2s ease-in-out infinite;}
@keyframes ipfpulse{0%,100%{opacity:1;}50%{opacity:.3;}}
#ipf-wrap{position:fixed;inset:0;z-index:2147483646;background:rgba(4,8,18,.6);display:none;align-items:center;justify-content:center;}
#ipf-wrap.open{display:flex;}
#ipf-panel{zoom:var(--ipf-z,1);width:calc(92vw / var(--ipf-z,1));max-width:860px;max-height:calc(88vh / var(--ipf-z,1));background:rgba(12,18,32,.96);border:1px solid rgba(90,170,255,.4);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;font:13px Arial,sans-serif;color:#e8f0ff;box-shadow:0 24px 64px rgba(0,0,0,.7);}
#ipf-hdr{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid rgba(90,170,255,.3);}
#ipf-hdr .t{font-weight:800;color:#9cc9ff;}
#ipf-hdr .v{font-size:10px;color:#5a7fa0;border:1px solid rgba(90,170,255,.3);border-radius:4px;padding:1px 6px;}
.ipf-zoom{margin-left:auto;display:flex;align-items:center;gap:4px;}
.ipf-zoom button{width:24px;height:24px;border-radius:6px;border:1px solid rgba(90,170,255,.4);background:rgba(90,170,255,.12);color:#cfe4ff;font:700 14px Arial,sans-serif;cursor:pointer;line-height:1;padding:0;}
.ipf-zoom span{min-width:42px;text-align:center;font-size:11px;color:rgba(200,220,255,.7);cursor:pointer;}
#ipf-close{background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer;}
#ipf-body{display:flex;gap:16px;padding:16px 18px;overflow:hidden;flex:1;min-height:0;}
#ipf-side{width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:10px;}
#ipf-main{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;}
.ipf-sec{font-size:9px;font-weight:700;color:#5a7fa0;text-transform:uppercase;letter-spacing:.7px;}
.ipf-field{border-radius:8px;padding:8px 10px;font-size:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);}
.ipf-field.ok{border-color:rgba(63,250,130,.4);color:#5fd876;background:rgba(63,250,130,.07);}
.ipf-field.warn{border-color:rgba(240,165,0,.35);color:#f0a500;background:rgba(240,165,0,.06);}
#ipf-ids{width:100%;box-sizing:border-box;height:110px;resize:vertical;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e0ecff;font:12px monospace;outline:none;}
.ipf-btn{width:100%;padding:9px;border-radius:8px;border:1px solid rgba(90,170,255,.6);background:rgba(90,170,255,.18);color:#cfe4ff;font:800 12px Arial,sans-serif;cursor:pointer;}
.ipf-btn:disabled{opacity:.35;cursor:not-allowed;}
#ipf-stop{display:none;border-color:rgba(250,80,80,.4);background:rgba(250,80,80,.08);color:#f06060;}
.ipf-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}
.ipf-metric{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:9px;padding:8px 4px;text-align:center;}
.ipf-metric .val{font-size:20px;font-weight:800;color:#fff;}
.ipf-metric .lbl{font-size:8px;color:rgba(180,210,255,.45);text-transform:uppercase;letter-spacing:.6px;margin-top:3px;}
#ipf-found{flex:1;overflow-y:auto;min-height:120px;}
.ipf-item{padding:6px 9px;margin-bottom:4px;border-radius:7px;background:rgba(90,170,255,.08);border:1px solid rgba(90,170,255,.25);font-size:11px;}
.ipf-item b{color:#9cc9ff;}
.ipf-item .sub{color:rgba(200,220,255,.5);margin-top:2px;}
#ipf-pb-wrap{height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;}
#ipf-pb{height:100%;width:0;background:linear-gradient(90deg,#3a6fa0,#7fbaff);transition:width .3s;}
#ipf-status{font-size:11px;color:rgba(180,210,255,.6);min-height:16px;}
#ipf-toast{zoom:var(--ipf-z,1);position:fixed;bottom:180px;left:16px;z-index:2147483647;padding:12px 18px;border-radius:12px;color:#e0ecff;font:600 12px Arial,sans-serif;max-width:340px;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none;}
`);

// ════════════════════════════════════════════════════
// HTML
// ════════════════════════════════════════════════════
var fab = document.createElement('button');
fab.id = 'ipf-fab';
fab.title = 'Alt+I — открыть/закрыть';
fab.innerHTML = '<span class="dot"></span><span>In Progress</span>';
document.body.appendChild(fab);

var wrap = document.createElement('div');
wrap.id = 'ipf-wrap';
wrap.innerHTML =
  '<div id="ipf-panel">' +
    '<div id="ipf-hdr"><span class="t">⏳ In Progress Finder</span><span class="v">' + VERSION + '</span><div class="ipf-zoom" title="Масштаб окна (клик по % — сброс)"><button id="ipf-zoom-out">−</button><span id="ipf-zoom-val">100%</span><button id="ipf-zoom-in">+</button></div><button id="ipf-close">✕</button></div>' +
    '<div id="ipf-body">' +
      '<div id="ipf-side">' +
        '<div class="ipf-sec">Вариант 1 — список из фильтра</div>' +
        '<div class="ipf-field warn" id="ipf-apply">⚠ Нажми APPLY в фильтре — перехвачу список</div>' +
        '<button class="ipf-btn" id="ipf-run-apply" disabled>▶ In progress по APPLY</button>' +
        '<div class="ipf-sec" style="margin-top:6px">Вариант 2 — свои ID тикетов</div>' +
        '<textarea id="ipf-ids" placeholder="23739196863&#10;23739196864&#10;… (любой разделитель)"></textarea>' +
        '<button class="ipf-btn" id="ipf-run-ids">▶ In progress по списку</button>' +
        '<button class="ipf-btn" id="ipf-stop">⏹ Стоп — экспорт</button>' +
        '<label style="font-size:11px;color:rgba(200,220,255,.6);display:flex;align-items:center;gap:8px">Потоков (1–5): <input id="ipf-threads" type="number" min="1" max="5" value="' + DEFAULT_THREADS + '" style="width:48px;padding:4px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#e0ecff"></label>' +
        '<div style="font-size:10px;color:rgba(200,220,255,.4);line-height:1.4">Список тикетов в статусе <b>In progress</b> / <b>In progress (M)</b>: кто последним работал с тикетом и его Inside comment. В фильтре выбери статусы In progress и нажми APPLY; тикеты, которые уже вышли из In progress, пропускаются.</div>' +
      '</div>' +
      '<div id="ipf-main">' +
        '<div class="ipf-metrics">' +
          '<div class="ipf-metric"><div class="val" id="ipf-m-total">—</div><div class="lbl">Тикетов</div></div>' +
          '<div class="ipf-metric"><div class="val" id="ipf-m-done">0</div><div class="lbl">Проверено</div></div>' +
          '<div class="ipf-metric"><div class="val" id="ipf-m-found" style="color:#7fbaff">0</div><div class="lbl">In progress</div></div>' +
          '<div class="ipf-metric"><div class="val" id="ipf-m-skip" style="color:#f93">0</div><div class="lbl">Пропущено</div></div>' +
        '</div>' +
        '<div class="ipf-sec">Тикеты In progress</div>' +
        '<div id="ipf-found"></div>' +
        '<div id="ipf-pb-wrap"><div id="ipf-pb"></div></div>' +
        '<div id="ipf-status">Готов к запуску</div>' +
      '</div>' +
    '</div>' +
  '</div>';
document.body.appendChild(wrap);

function $(id){ return document.getElementById(id); }
function togglePanel(){ wrap.classList.toggle('open'); }
fab.addEventListener('click', togglePanel);
$('ipf-close').addEventListener('click', function(){ wrap.classList.remove('open'); });

// ── Масштаб окна (для мелкого масштаба страницы, напр. 67%). Запоминается в localStorage.
var SCALE_MIN = 0.8, SCALE_MAX = 2, SCALE_STEP = 0.1, SCALE_KEY = 'ipf_scale';
var uiScale = 1;
try { uiScale = parseFloat(localStorage.getItem(SCALE_KEY)) || 1; } catch(e){}
function applyScale(v){
  uiScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 10) / 10));
  document.documentElement.style.setProperty('--ipf-z', String(uiScale));
  $('ipf-zoom-val').textContent = Math.round(uiScale * 100) + '%';
  try { localStorage.setItem(SCALE_KEY, String(uiScale)); } catch(e){}
}
$('ipf-zoom-in').addEventListener('click', function(){ applyScale(uiScale + SCALE_STEP); });
$('ipf-zoom-out').addEventListener('click', function(){ applyScale(uiScale - SCALE_STEP); });
$('ipf-zoom-val').addEventListener('click', function(){ applyScale(1); });
applyScale(uiScale);

wrap.addEventListener('click', function(e){ if(e.target === wrap) wrap.classList.remove('open'); });
document.addEventListener('keydown', function(e){
  if(e.altKey && (e.code === 'KeyI' || e.key === 'i' || e.key === 'I')){ e.preventDefault(); e.stopPropagation(); togglePanel(); }
}, true);

// ════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════
function setStatus(m){ $('ipf-status').textContent = m; }
function showToast(msg, type){
  var old = $('ipf-toast'); if(old) old.remove();
  var t = document.createElement('div');
  t.id = 'ipf-toast';
  t.style.background = type === 'ok' ? 'rgba(0,80,30,.92)' : type === 'err' ? 'rgba(90,15,15,.92)' : 'rgba(70,50,10,.92)';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 4500);
}
function updateApplyState(){
  var el = $('ipf-apply'); if(!el) return;
  if(_listUrl){
    el.className = 'ipf-field ok';
    el.textContent = '✅ Фильтр пойман' + (_listPayload && _listPayload.dateFrom ? ' (с ' + _listPayload.dateFrom + ')' : '');
  }
  $('ipf-run-apply').disabled = !_listUrl || state.running;
}
function setProgress(){
  var total = Math.max(state.total, state.expectedTotal || 0);
  $('ipf-m-total').textContent = total || '—';
  $('ipf-m-done').textContent = state.done;
  $('ipf-m-found').textContent = state.found.length;
  $('ipf-m-skip').textContent = state.skipped;
  $('ipf-pb').style.width = (total ? Math.round(state.done / total * 100) : 0) + '%';
}
function addFoundItem(f){
  var div = document.createElement('div');
  div.className = 'ipf-item';
  div.innerHTML = '<b>#' + esc(f.ticketId) + '</b> — ' + esc(f.admin || 'без Admin username') +
    (f.department ? ' · ' + esc(f.department) : '') +
    '<div class="sub">' + esc(f.date) + (f.comment ? ' — ' + esc(f.comment.slice(0, 140)) : '') + '</div>';
  var box = $('ipf-found');
  box.insertBefore(div, box.firstChild);
}
function setRunning(on){
  state.running = on;
  fab.classList.toggle('running', on);
  $('ipf-run-ids').disabled = on;
  $('ipf-stop').style.display = on ? 'block' : 'none';
  updateApplyState();
}

// ════════════════════════════════════════════════════
// FETCH — СПИСОК СТРАНИЦ
// Возвращает {tickets:[{ticketId,country}], hasMore} или null, если страница пустая.
// ════════════════════════════════════════════════════
function fetchListPage(pageNum, pollAttempt){
  pollAttempt = pollAttempt || 0;
  var payload = JSON.parse(JSON.stringify(_listPayload));
  payload[_pageKey(payload)] = pageNum;
  var pageSize = Number(payload.countOfItemPage || payload.perPage) || 0;
  function fail(reason){ return {ok:false, reason:reason, tickets:[]}; }
  return fetch(_listUrl, {method:'POST', headers:getHeaders(true), credentials:'include', body:JSON.stringify(payload)})
    .then(function(r){ return r.text().then(function(text){ return {status:r.status, ok:r.ok, text:text}; }); })
    .then(function(res){
      var t = res.text.replace(/^\s+/, '');
      if(t.indexOf('<!DOCTYPE') === 0 || t.indexOf('<html') === 0) throw new Error('SESSION_EXPIRED');
      if(!res.ok) return fail('HTTP ' + res.status);
      var resp; try{ resp = JSON.parse(res.text); }catch(e){ return fail('ответ не JSON'); }
      if(resp.is_polling && resp.count < 5 && pollAttempt < POLL_MAX){
        setStatus('⏳ Загружаю стр.' + pageNum + '... (' + (pollAttempt + 1) + '/' + POLL_MAX + ')');
        return sleep(POLL_INTERVAL).then(function(){ return fetchListPage(pageNum, pollAttempt + 1); });
      }
      // Общее число тикетов: {total} лежит рядом с массивом тикетов в data (ExtendedPaymentRequestList)
      var total = null;
      (Array.isArray(resp.data) ? resp.data : []).forEach(function(x){
        if(x && !Array.isArray(x) && typeof x.total === 'number') total = x.total;
      });
      var raw = Array.isArray(resp.data) ? resp.data : [];
      if(Array.isArray(raw[0])) raw = raw[0];
      var tickets = raw.map(function(item){
        var t2 = Array.isArray(item) ? item[0] : item; if(!t2) return null;
        return {
          ticketId:String(t2.idTicket || t2.idTkt || ''), country:t2.nameCountry || '',
          status:String(t2.nameExternalStatus || t2.externalStatus || ''),
          userId:String(t2.idUser || t2.userId || ''),
          subagent:t2.nameSubagent || t2.transactionSubagentName || '',
          referral:t2.nameRef || '',
          agent:t2.nameAgent || '',
          department:t2.department || t2.nameDepartment || '',
          ticketType:t2.requestTypeName || '',
          createdAt:t2.dtCreate || ''
        };
      }).filter(function(t2){ return t2 && /^\d{5,}$/.test(t2.ticketId); });
      var size = pageSize || tickets.length || 1;
      // Сервер присылает настоящий total только на стр.1, на следующих — {total: 0}.
      // Поэтому решаем по total за весь прогон (максимум из положительных), а не по total этой страницы.
      var known = Math.max(state.expectedTotal || 0, total > 0 ? total : 0) || null;
      var serverHasMore = resp.otherData ? resp.otherData.hasMore : undefined;
      console.log('[IPF] стр.' + pageNum + ': тикетов ' + tickets.length + ', total ' + total + ' (за прогон ' + known + '), is_polling ' + resp.is_polling + ', count ' + resp.count);

      if(!tickets.length){
        // Пустая страница: это конец, только если сервер так и говорит (или total за прогон это подтверждает).
        // Иначе сервер ещё не подготовил страницу — сигнализируем ошибку, чтобы её перезапросили.
        if(serverHasMore === false) return {ok:true, tickets:[], hasMore:false, total:total};
        if(known != null && (pageNum - 1) * size >= known) return {ok:true, tickets:[], hasMore:false, total:total};
        if(known == null && !resp.is_polling) return {ok:true, tickets:[], hasMore:false, total:total};
        return fail(resp.is_polling ? 'сервер ещё готовит страницу (is_polling)' : 'пустая страница, хотя total = ' + known);
      }
      var hasMore;
      if(serverHasMore === false) hasMore = false;                 // PaymentSupport list
      else if(known != null) hasMore = pageNum * size < known;     // ExtendedPaymentRequestList
      else hasMore = true;                                         // total неизвестен — идём до пустой страницы
      return {ok:true, tickets:tickets, hasMore:hasMore, total:total};
    })
    .catch(function(e){ if(e.message === 'SESSION_EXPIRED') throw e; return fail('сеть: ' + (e && e.message)); });
}

// ════════════════════════════════════════════════════
// FETCH — ИСТОРИЯ ТИКЕТА (как в Reporter)
// ════════════════════════════════════════════════════
function fetchTicket(ticketId, attempt){
  attempt = attempt || 1;
  return fetch('/admin/backoffice/paymentsupporthistory', {
    method:'POST', headers:getHeaders(false), credentials:'include',
    body:'ticketId=' + encodeURIComponent(ticketId) + '&is_iframe=1'
  }).then(function(r){
    if([429, 502, 503, 504, 529].indexOf(r.status) !== -1){
      adaptDelay(false);
      if(attempt <= MAX_RETRIES){
        setStatus('⏳ ' + r.status + ' — #' + ticketId + ', retry ' + attempt + '/' + MAX_RETRIES);
        return sleep(attempt * 2000).then(function(){ return fetchTicket(ticketId, attempt + 1); });
      }
      state.skipped++; return null;
    }
    adaptDelay(true);
    return r.text().then(function(text){
      var t = text.replace(/^\s+/, '');
      if(t.indexOf('<!DOCTYPE') === 0 || t.indexOf('<html') === 0) throw new Error('SESSION_EXPIRED');
      try{ return JSON.parse(text); }
      catch(e){
        if(attempt <= MAX_RETRIES) return sleep(3500).then(function(){ return fetchTicket(ticketId, attempt + 1); });
        state.skipped++; return null;
      }
    });
  }).catch(function(e){
    if(e.message === 'SESSION_EXPIRED') throw e;
    if(attempt <= MAX_RETRIES) return sleep(3500).then(function(){ return fetchTicket(ticketId, attempt + 1); });
    state.skipped++; return null;
  });
}

// ════════════════════════════════════════════════════
// ОБРАБОТКА
// ════════════════════════════════════════════════════
function handleTicket(t, resp){
  if(!resp || !resp.success || !resp.data){
    if(resp) state.skipped++;
    return;
  }
  handleInProgress(t, resp.data);
}

// Статус — из строки списка (он актуальный), для списка ID — из последней строки истории.
// Admin username и Inside comment — из самой свежей строки истории.
function handleInProgress(t, data){
  var r = Detector.analyzeInProgress(data);
  if(!r){ state.skipped++; return; }
  var status = t.status || r.status;
  if(!Detector.isInProgress(status)){ state.notInProgress++; return; }
  var f = {
    ticketId:t.ticketId,
    userId:t.userId || r.userId,
    subagent:t.subagent || r.subagent,
    referral:t.referral || '',
    agent:t.agent || r.agent,
    department:t.department || r.department,
    ticketType:t.ticketType || r.ticketType,
    country:t.country || '',   // ГЕО есть только в строке списка, в истории его нет
    // дата создания — из списка (dtCreate); для списка ID — самая ранняя строка истории
    createdAt:t.createdAt || r.firstDate,
    admin:r.admin, comment:r.comment, date:r.date, status:status
  };
  state.found.push(f);
  addFoundItem(f);
}

function getThreads(){
  var n = parseInt(($('ipf-threads') || {}).value, 10);
  return Math.min(5, Math.max(1, n || DEFAULT_THREADS));
}
function fmtEta(){
  var total = Math.max(state.total, state.expectedTotal || 0);
  if(!state.done || !total || state.done >= total) return '';
  var msPer = (Date.now() - state.startTime) / state.done;
  var min = Math.round(msPer * (total - state.done) / 60000);
  return min >= 60 ? ' | ~' + Math.floor(min / 60) + ' ч ' + (min % 60) + ' мин' : ' | ~' + min + ' мин';
}
// Параллельная обработка: N воркеров разбирают общую очередь тикетов
function runPool(tickets){
  var idx = 0;
  function worker(){
    if(!state.running || idx >= tickets.length) return Promise.resolve();
    var t = tickets[idx++];
    if(t.status && !Detector.isInProgress(t.status)){
      // по списку видно, что тикет не в In progress — историю не грузим
      state.notInProgress++; state.done++; setProgress();
      return Promise.resolve().then(worker);
    }
    return fetchTicket(t.ticketId).then(function(resp){
      handleTicket(t, resp);
      state.done++;
      setProgress();
      setStatus((state.source === 'apply' ? 'Стр.' + state.currentPage + ' | ' : '') +
        state.done + '/' + Math.max(state.total, state.expectedTotal || 0) + ' → #' + t.ticketId + fmtEta());
      return sleep(state._delay);
    }).then(worker);
  }
  var workers = [];
  for(var w = 0; w < Math.min(getThreads(), tickets.length); w++) workers.push(worker());
  return Promise.all(workers);
}

function resetRun(source){
  state.notInProgress = 0;
  state.source = source; state.total = 0; state.done = 0; state.skipped = 0; state.currentPage = 1;
  state.processedIds = {}; state.found = []; state._delay = DELAY_MIN; state._finishing = false; state.expectedTotal = 0;
  state.stopReason = ''; state.pagesDone = 0;
  state.startTime = Date.now();
  $('ipf-found').innerHTML = '';
  setProgress();
  setRunning(true);
  startKeepalive();
}

function onError(e){
  if(e && e.message === 'SESSION_EXPIRED'){
    showToast('🔐 Сессия истекла — войди заново. Выгружаю найденное.', 'err');
    finishCollection('🔐 Сессия истекла');
    return;
  }
  console.error('[IPF]', e);
  finishCollection('⚠ Ошибка: ' + (e && e.message));
}

function collectPage(attempt){
  attempt = attempt || 0;
  fetchListPage(state.currentPage).then(function(page){
    if(!state.running){ finishCollection(); return; }
    if(page.total > 0) state.expectedTotal = Math.max(state.expectedTotal || 0, page.total); // total 0 со стр.2+ игнорируем
    if(!page.ok){
      // Сбой страницы — не конец списка: перезапрашиваем с нарастающей паузой
      if(attempt < LIST_RETRIES){
        var wait = Math.min(LIST_RETRY_BASE_MS * (attempt + 1), 20000);
        setStatus('⚠ Стр.' + state.currentPage + ': ' + page.reason + '. Повтор ' + (attempt + 1) + '/' + LIST_RETRIES + ' через ' + Math.round(wait / 1000) + ' с');
        return sleep(wait).then(function(){ if(state.running) collectPage(attempt + 1); else finishCollection(); });
      }
      state.stopReason = 'стр.' + state.currentPage + ' не загрузилась после ' + LIST_RETRIES + ' повторов: ' + page.reason;
      finishCollection('⚠ ' + state.stopReason);
      return;
    }
    if(!page.tickets.length){ finishCollection(); return; }
    var fresh = page.tickets.filter(function(t){
      if(state.processedIds[t.ticketId]) return false;
      state.processedIds[t.ticketId] = 1;
      return true;
    });
    state.pagesDone = state.currentPage;
    // защита от бесконечного цикла, если сервер игнорирует номер страницы
    if(!fresh.length){
      state.stopReason = 'стр.' + state.currentPage + ' повторяет уже проверенные тикеты';
      finishCollection('⚠ ' + state.stopReason);
      return;
    }
    state.total += fresh.length;
    setProgress();
    return runPool(fresh).then(function(){
      if(!state.running || !page.hasMore){ finishCollection(); return; }
      state.currentPage++;
      setTimeout(function(){ collectPage(0); }, PAGE_WAIT_MS);
    });
  }).catch(onError);
}

$('ipf-run-apply').addEventListener('click', function(){
  if(state.running) return;
  if(!_listUrl){ showToast('⚠ Сначала нажми APPLY в фильтре', 'warn'); return; }
  resetRun('apply');
  setStatus('Запуск...');
  collectPage();
});

$('ipf-run-ids').addEventListener('click', function(){
  if(state.running) return;
  var ids = parseIds($('ipf-ids').value);
  if(!ids.length){ showToast('⚠ Вставь ID тикетов (5+ цифр)', 'warn'); return; }
  resetRun('ids');
  state.total = ids.length;
  setProgress();
  var tickets = ids.map(function(id){ return {ticketId:id, country:''}; });
  runPool(tickets).then(function(){ finishCollection(); }).catch(onError);
});

$('ipf-stop').addEventListener('click', function(){
  if(!state.running) return;
  state.running = false; // цикл остановится на следующем тикете и вызовет finishCollection
  setStatus('⏹ Останавливаю...');
});

function finishCollection(reason){
  if(state._finishing) return;
  state._finishing = true;
  setRunning(false);
  stopKeepalive();
  var mins = Math.max(1, Math.round((Date.now() - state.startTime) / 60000));
  console.log('[IPF ' + VERSION + '] Проверено: ' + state.done + ' | In progress: ' + state.found.length + ' | пропущено: ' + state.skipped + ' | ~' + mins + ' мин');
  if(!state.done){
    setStatus((reason ? reason + ' — ' : '') + 'нет проверенных тикетов');
    return;
  }
  try{
    var fn = buildXLSX();
    setStatus((reason ? reason + ' | ' : '✅ ') + fn + ' | проверено ' + state.done + ', In progress ' + state.found.length);
    showToast('✅ ' + fn + ' | In progress ' + state.found.length + ' из ' + state.done, 'ok');
  }catch(e){
    console.error('[IPF] Excel', e);
    setStatus('⚠ Ошибка Excel: ' + e.message);
  }
}

// ════════════════════════════════════════════════════
// EXCEL
// ════════════════════════════════════════════════════
var XC = {W:'FFFFFFFF', alt:'FFF4F8FB', DT:'FF1F1F1F', rB:'FFFFC7CE', rF:'FF9C0006', yB:'FFFFEB9C', yF:'FF9C6500'};
function xhdr(){ return {font:{bold:true,color:{rgb:'FF000000'},name:'Arial',sz:10},fill:{patternType:'solid',fgColor:{rgb:'FFD7E4F0'}},alignment:{horizontal:'center',vertical:'center',wrapText:true},border:{bottom:{style:'thin',color:{rgb:'FF999999'}},right:{style:'thin',color:{rgb:'FF999999'}}}}; }
function xcs(bg, fg){ return {font:{color:{rgb:fg || XC.DT},name:'Arial',sz:10},fill:{patternType:'solid',fgColor:{rgb:bg || XC.W}},alignment:{horizontal:'left',vertical:'top',wrapText:true},border:{right:{style:'thin',color:{rgb:'FFD9D9D9'}},bottom:{style:'thin',color:{rgb:'FFD9D9D9'}}}}; }

// rowStyle(i) → [bg, fg] для строки данных i (0-based)
function makeSheet(wb, name, hdr, rows, widths, rowStyle){
  var ws = XLSX.utils.aoa_to_sheet([hdr].concat(rows));
  ws['!cols'] = widths.map(function(w){ return {wch:w}; });
  var rng = XLSX.utils.decode_range(ws['!ref']);
  for(var r = 0; r <= rng.e.r; r++){
    var st = r === 0 ? null : (rowStyle ? rowStyle(r - 1) : null);
    for(var c = 0; c <= rng.e.c; c++){
      var a = XLSX.utils.encode_cell({r:r, c:c});
      if(!ws[a]) ws[a] = {t:'s', v:''};
      ws[a].s = r === 0 ? xhdr() : xcs(st ? st[0] : (r % 2 === 0 ? XC.alt : XC.W), st ? st[1] : XC.DT);
    }
  }
  ws['!freeze'] = {xSplit:0, ySplit:1};
  ws['!autofilter'] = {ref:XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:0,c:hdr.length - 1}})};
  XLSX.utils.book_append_sheet(wb, ws, name);
}

// Общие строки «Сводки»: откуда список и весь ли он пройден
function summaryHead(){
  return [
    ['Источник', state.source === 'apply' ? 'Фильтр (APPLY)' + (_listPayload && _listPayload.dateFrom ? ', с ' + _listPayload.dateFrom : '') : 'Список ID'],
    ['Проверено тикетов', state.done],
    ['Тикетов по фильтру (total)', state.expectedTotal || '—'],
    ['Пройдено страниц', state.source === 'apply' ? state.pagesDone : '—'],
    ['Сбор завершён', state.stopReason ? 'РАНЬШЕ ВРЕМЕНИ: ' + state.stopReason : (state.expectedTotal && state.done < state.expectedTotal ? 'остановлен вручную или не все тикеты загрузились' : 'полностью')]
  ];
}

// Excel: листы по Inside comment / Admin username + Сводка
function buildXLSX(){
  var wb = XLSX.utils.book_new();
  var found = state.found.slice().sort(function(a, b){
    return String(a.admin).localeCompare(String(b.admin)) || String(a.ticketId).localeCompare(String(b.ticketId));
  });
  // Листы: сначала «waiting for» в Inside comment, остальные — по префиксу Admin username.
  // Лист создаётся всегда, даже пустой, чтобы набор листов не менялся от выгрузки к выгрузке.
  var SHEETS = [
    {key:'waiting',          name:'Waiting for',          label:'Inside comment с «waiting for»'},
    {key:'pay_mena',         name:'pay_mena',             label:'Admin username pay_mena_*'},
    {key:'pay_mena_antifraud', name:'pay_mena_antifraud', label:'Admin username pay_mena_antifraud_*'},
    {key:'pay_support_mena', name:'pay_support_mena',     label:'Admin username pay_support_mena_*'},
    {key:'pay_cm_mena',      name:'pay_cm_mena',          label:'Admin username pay_cm_mena_*'},
    {key:'other',            name:'Остальные',            label:'Остальные Admin username'}
  ];
  var groups = {};
  SHEETS.forEach(function(sh){ groups[sh.key] = []; });
  found.forEach(function(f){ groups[Detector.inProgressGroup(f.admin, f.comment)].push(f); });
  SHEETS.forEach(function(sh){
    makeSheet(wb, sh.name,
      ['Ticket ID','Ticket type','GEO','User ID','Subagent','Referral','Agent','Department','Admin username','Inside comment','Дата создания','Последнее изменение','External status'],
      groups[sh.key].map(function(f){
        return [f.ticketId, f.ticketType, f.country, f.userId, f.subagent, f.referral, f.agent, f.department, f.admin, f.comment, f.createdAt, f.date, f.status];
      }),
      [14, 12, 12, 14, 22, 16, 22, 14, 26, 60, 20, 20, 18]
    );
  });

  function countBy(key){
    var m = {};
    found.forEach(function(f){ var k = f[key] || '—'; m[k] = (m[k] || 0) + 1; });
    return Object.keys(m).sort(function(a, b){ return m[b] - m[a] || a.localeCompare(b); }).map(function(k){ return [k, m[k]]; });
  }
  var summary = summaryHead().concat([
    ['В статусе In progress', found.length],
    ['Уже не In progress (пропущены)', state.notInProgress],
    ['Пропущено (ошибка загрузки)', state.skipped],
    ['Дата выгрузки', new Date().toLocaleString('ru-RU')],
    ['', ''],
    ['По листам', 'Тикетов']
  ]).concat(SHEETS.map(function(sh){ return [sh.name + ' — ' + sh.label, groups[sh.key].length]; }))
    .concat([['', ''], ['По Admin username', 'Тикетов']]).concat(countBy('admin')).concat([['', ''], ['По Department', 'Тикетов']]).concat(countBy('department'));
  makeSheet(wb, 'Сводка', ['Показатель', 'Значение'], summary, [40, 30]);

  var fn = 'in_progress_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fn);
  return fn;
}

setTimeout(updateApplyState, 1500);
console.log('%c[IPF ' + VERSION + '] загружен — Alt+I', 'color:#7fbaff;font-weight:bold');
})();
