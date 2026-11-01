// ==UserScript==
// @name         pay_mena Double Mistake Finder
// @namespace    http://tampermonkey.net/
// @version      1.0.4
// @description  Ищет тикеты, где Approved (M) 2+ раза возвращали в Sent for processing (M) с комментарием "Sir, please attach the approved transaction..."
// @match        *://th-managment.com/*
// @match        *://*.th-managment.com/*
// @match        *://webmanegment.com/*
// @match        *://*.webmanegment.com/*
// @require      https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js
// @grant        GM_addStyle
// @run-at       document-idle
// @homepageURL  https://github.com/partenkoEgor/double_mistake_finder
// @updateURL    https://raw.githubusercontent.com/partenkoEgor/double_mistake_finder/main/pay_mena_double_mistake_finder.user.js
// @downloadURL  https://raw.githubusercontent.com/partenkoEgor/double_mistake_finder/main/pay_mena_double_mistake_finder.user.js
// ==/UserScript==
(function(){'use strict';

// ════════════════════════════════════════════════════
// DETECTOR — чистая логика без DOM (тестируется в Node)
// ════════════════════════════════════════════════════
var Detector = (function(){
  var MIN_CYCLES     = 2;                                      // сколько циклов считаем "двойной ошибкой"
  var RETURN_PHRASE  = 'please attach the approved transaction'; // ключевая часть комментария
  var PAY_MENA_RE    = /^pay_mena_\d+$/i;

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
        comment: str(r.commentSupport)
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

  function isApproved(row){
    return /^approved\b/.test(norm(row.status));          // "Approved (M)"
  }
  function isReturnComment(text){
    return norm(text).indexOf(RETURN_PHRASE) !== -1;
  }
  function isReturn(row){
    return PAY_MENA_RE.test(row.admin) &&
      /^sent for processing\b/.test(norm(row.status)) &&  // "Sent for processing (M)"
      isReturnComment(row.comment);
  }

  // Цикл = Approved → (что угодно) → pay_mena_* ставит Sent for processing с комментарием.
  // Возврат без Approved перед ним не считается; один Approved закрывается одним возвратом.
  function findCycles(rows){
    var cycles = [], approved = null;
    rows.forEach(function(r){
      if(isApproved(r)){
        approved = r;
      }else if(isReturn(r) && approved){
        cycles.push({
          approvedAt: approved.date, approvedBy: approved.admin, approvedComment: approved.comment,
          returnedAt: r.date, returnedBy: r.admin, returnedByName: r.adminName, comment: r.comment
        });
        approved = null;
      }
    });
    return cycles;
  }

  function analyzeHistory(data){
    var rows = normalizeHistory(data);
    var cycles = findCycles(rows);
    var last = rows.length ? rows[rows.length - 1] : null;
    return {
      count: cycles.length,
      isDouble: cycles.length >= MIN_CYCLES,
      cycles: cycles,
      lastStatus: last ? last.status + (last.internalStatus ? ' / ' + last.internalStatus : '') : '',
      lastDate: last ? last.date : '',
      lastAdmin: last ? last.admin : ''
    };
  }

  return {
    MIN_CYCLES: MIN_CYCLES, RETURN_PHRASE: RETURN_PHRASE,
    norm: norm, normalizeHistory: normalizeHistory, isApproved: isApproved,
    isReturn: isReturn, isReturnComment: isReturnComment, findCycles: findCycles,
    analyzeHistory: analyzeHistory
  };
})();

// Node (тесты): отдаём детектор и не трогаем DOM
if(typeof module !== 'undefined' && module.exports){ module.exports = Detector; return; }

// не запускаться во фреймах и не инжектиться дважды
if(window.top !== window.self) return;
if(window.__pm_dmf_loaded) return;
window.__pm_dmf_loaded = true;

// ════════════════════════════════════════════════════
// КОНФИГ
// ════════════════════════════════════════════════════
var VERSION       = '1.0.4';
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
// АГЕНТЫ (ФИО для отчета)
// ════════════════════════════════════════════════════
var AGENTS = {
  'pay_mena_63':'Жанат Мейржан','pay_mena_106':'Шаймарданов Мадияр','pay_mena_110':'Айтбатыр Айжан',
  'pay_mena_116':'Кадиров Марлен','pay_mena_141':'Дарвакулов Дильмурат','pay_mena_184':'Чугункова Ульяна',
  'pay_mena_193':'Тарасов Вячеслав','pay_mena_201':'Ильясов Димаш','pay_mena_230':'Дзюбан Егор',
  'pay_mena_245':'Игорь Китайгородский','pay_mena_246':'Виктория Куклева','pay_mena_272':'Исмаилова Мария',
  'pay_mena_279':'Васинский Кирилл','pay_mena_323':'Кириенко Мария','pay_mena_330':'Гамза Кирилл',
  'pay_mena_333':'Романова Ильина','pay_mena_342':'Байзен Жамал','pay_mena_348':'Дюсенбаева Инара',
  'pay_mena_379':'Гайнетдинов Руслан','pay_mena_390':'Виктория Зотова','pay_mena_410':'Когай Екатерина',
  'pay_mena_429':'Савостенко Денис','pay_mena_431':'Лытнев Сергей','pay_mena_433':'Недилько Александра',
  'pay_mena_436':'Поляничев Михаил','pay_mena_441':'Питаев Анатолий','pay_mena_442':'Партенко Егор',
  'pay_mena_447':'Ефремова Вероника','pay_mena_448':'Голиней Богдан','pay_mena_459':'Байканов Ильдар',
  'pay_mena_470':'Доброва Надежда','pay_mena_471':'Имамутдинов Глеб','pay_mena_476':'Ткаченко Наталья',
  'pay_mena_486':'Бабак Виктория','pay_mena_495':'Костюхин Алексей','pay_mena_496':'Магдинов Алмаз',
  'pay_mena_509':'Маликова Елизавета','pay_mena_511':'Ушаков Артур','pay_mena_513':'Белов Федор',
  'pay_mena_516':'Платонов Кирилл','pay_mena_525':'Матева Анастасия','pay_mena_529':'Красюк Никита',
  'pay_mena_533':'Ларуков Давид','pay_mena_535':'Лежнев Макар','pay_mena_537':'Иваненко Олег',
  'pay_mena_542':'Багаутдинова Диана','pay_mena_543':'Васильев Максим','pay_mena_544':'Шестаков Александр',
  'pay_mena_545':'Дмитриев Никита','pay_mena_593':'Спесивцева Арина','pay_mena_601':'Матрук Сергей',
  'pay_mena_614':'Синельникова Софья','pay_mena_618':'Тарасов Илья','pay_mena_630':'Локтяжнов Артём',
  'pay_mena_645':'Алтухов Даниель','pay_mena_646':'Мухаметдинов Руслан','pay_mena_652':'Яцкова Дарья',
  'pay_mena_653':'Кучкарева Алена','pay_mena_654':'Шагабутдинов Марсель',
  'pay_mena_658':'Богуцкая Арина','pay_mena_659':'Соболев Вячеслав',
  'pay_mena_662':'Сулейманов Ринат','pay_mena_663':'Силантьев Илья','pay_mena_665':'Мингазов Артур',
  'pay_mena_668':'Киреев Сергей','pay_mena_669':'Онуфрейчук Никита','pay_mena_670':'Бородай Иван',
  'pay_mena_671':'Мифтахова Айгуль','pay_mena_681':'Якубов Максад','pay_mena_682':'Кадаев Ильдар',
  'pay_mena_505':'Маньковский Федор','pay_mena_457':'Алексахин Константин','pay_mena_684':'Валиуллин Камиль',
  'pay_mena_692':'Габидуллин Рафаэль','pay_mena_693':'Тельнова Дарья','pay_mena_694':'Гафин Адель',
  'pay_mena_697':'Иванова Нелли','pay_mena_705':'Голубева Кристина','pay_mena_715':'Мухортова Дарья',
  'pay_mena_716':'Горло Захар','pay_mena_720':'Ризо Роман','pay_mena_721':'Князев Никита',
  'pay_mena_723':'Фарахутдинова Диана','pay_mena_724':'Гвоздев Ярослав'
};
function agentName(login){ return AGENTS[String(login || '').toLowerCase()] || ''; }

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
function withName(login, name){
  var n = name || agentName(login);
  return n ? login + ' (' + n + ')' : login;
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
  console.log('%c[DMF ' + VERSION + '] ✅ Список перехвачен', 'color:#3fa;font-weight:bold');
  updateApplyState();
}
(function(){
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this._dmf_m = m; this._dmf_u = u; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body){
    var self = this;
    if(this._dmf_m === 'POST' && body){
      try{
        var p = typeof body === 'string' ? JSON.parse(body) : body;
        if(_isListBody(p)){
          self.addEventListener('load', function(){
            try{
              var r = JSON.parse(self.responseText);
              if(_isListResp(r)) _applyCapture(self.responseURL || self._dmf_u, p);
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
/* Кнопка-«таблетка» как у Bulk Approve BETA; левый нижний угол над шестерёнкой меню, чтобы не перекрывать его кнопку справа */
#dmf-fab{position:fixed;left:16px;bottom:90px;z-index:2147483647;display:flex;align-items:center;gap:7px;padding:8px 14px;border-radius:999px;background:rgba(12,18,35,.9);border:1px solid rgba(255,110,90,.5);color:#ffb3a6;font:600 13px system-ui,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);user-select:none;}
#dmf-fab .dot{width:7px;height:7px;border-radius:50%;background:#ff6e5a;}
#dmf-fab.running .dot{animation:dmfpulse 1.2s ease-in-out infinite;}
@keyframes dmfpulse{0%,100%{opacity:1;}50%{opacity:.3;}}
#dmf-wrap{position:fixed;inset:0;z-index:2147483646;background:rgba(4,8,18,.6);display:none;align-items:center;justify-content:center;}
#dmf-wrap.open{display:flex;}
#dmf-panel{zoom:var(--dmf-z,1);width:calc(92vw / var(--dmf-z,1));max-width:860px;max-height:calc(88vh / var(--dmf-z,1));background:rgba(12,18,32,.96);border:1px solid rgba(255,110,90,.4);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;font:13px Arial,sans-serif;color:#e8f0ff;box-shadow:0 24px 64px rgba(0,0,0,.7);}
#dmf-hdr{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid rgba(255,110,90,.3);}
#dmf-hdr .t{font-weight:800;color:#ffb3a6;}
#dmf-hdr .v{font-size:10px;color:#a0605a;border:1px solid rgba(255,110,90,.3);border-radius:4px;padding:1px 6px;}
.dmf-zoom{margin-left:auto;display:flex;align-items:center;gap:4px;}
.dmf-zoom button{width:24px;height:24px;border-radius:6px;border:1px solid rgba(255,110,90,.4);background:rgba(255,110,90,.12);color:#ffcfc6;font:700 14px Arial,sans-serif;cursor:pointer;line-height:1;padding:0;}
.dmf-zoom span{min-width:42px;text-align:center;font-size:11px;color:rgba(200,220,255,.7);cursor:pointer;}
#dmf-close{background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer;}
#dmf-body{display:flex;gap:16px;padding:16px 18px;overflow:hidden;flex:1;min-height:0;}
#dmf-side{width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:10px;}
#dmf-main{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;}
.dmf-sec{font-size:9px;font-weight:700;color:#a0605a;text-transform:uppercase;letter-spacing:.7px;}
.dmf-field{border-radius:8px;padding:8px 10px;font-size:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);}
.dmf-field.ok{border-color:rgba(63,250,130,.4);color:#5fd876;background:rgba(63,250,130,.07);}
.dmf-field.warn{border-color:rgba(240,165,0,.35);color:#f0a500;background:rgba(240,165,0,.06);}
#dmf-ids{width:100%;box-sizing:border-box;height:110px;resize:vertical;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e0ecff;font:12px monospace;outline:none;}
.dmf-btn{width:100%;padding:9px;border-radius:8px;border:1px solid rgba(255,110,90,.6);background:rgba(255,110,90,.18);color:#ffcfc6;font:800 12px Arial,sans-serif;cursor:pointer;}
.dmf-btn:disabled{opacity:.35;cursor:not-allowed;}
#dmf-stop{display:none;border-color:rgba(250,80,80,.4);background:rgba(250,80,80,.08);color:#f06060;}
.dmf-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}
.dmf-metric{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:9px;padding:8px 4px;text-align:center;}
.dmf-metric .val{font-size:20px;font-weight:800;color:#fff;}
.dmf-metric .lbl{font-size:8px;color:rgba(180,210,255,.45);text-transform:uppercase;letter-spacing:.6px;margin-top:3px;}
#dmf-found{flex:1;overflow-y:auto;min-height:120px;}
.dmf-item{padding:6px 9px;margin-bottom:4px;border-radius:7px;background:rgba(255,110,90,.08);border:1px solid rgba(255,110,90,.25);font-size:11px;}
.dmf-item b{color:#ffb3a6;}
.dmf-item .sub{color:rgba(200,220,255,.5);margin-top:2px;}
#dmf-pb-wrap{height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;}
#dmf-pb{height:100%;width:0;background:linear-gradient(90deg,#a0405a,#ff9a85);transition:width .3s;}
#dmf-status{font-size:11px;color:rgba(180,210,255,.6);min-height:16px;}
#dmf-toast{zoom:var(--dmf-z,1);position:fixed;bottom:140px;left:16px;z-index:2147483647;padding:12px 18px;border-radius:12px;color:#e0ecff;font:600 12px Arial,sans-serif;max-width:340px;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none;}
`);

// ════════════════════════════════════════════════════
// HTML
// ════════════════════════════════════════════════════
var fab = document.createElement('button');
fab.id = 'dmf-fab';
fab.title = 'Alt+D — открыть/закрыть';
fab.innerHTML = '<span class="dot"></span><span>Double Mistakes</span>';
document.body.appendChild(fab);

var wrap = document.createElement('div');
wrap.id = 'dmf-wrap';
wrap.innerHTML =
  '<div id="dmf-panel">' +
    '<div id="dmf-hdr"><span class="t">🔁 Double Mistake Finder</span><span class="v">' + VERSION + '</span><div class="dmf-zoom" title="Масштаб окна (клик по % — сброс)"><button id="dmf-zoom-out">−</button><span id="dmf-zoom-val">100%</span><button id="dmf-zoom-in">+</button></div><button id="dmf-close">✕</button></div>' +
    '<div id="dmf-body">' +
      '<div id="dmf-side">' +
        '<div class="dmf-sec">Вариант 1 — список из фильтра</div>' +
        '<div class="dmf-field warn" id="dmf-apply">⚠ Нажми APPLY в фильтре — перехвачу список</div>' +
        '<button class="dmf-btn" id="dmf-run-apply" disabled>▶ Сбор по APPLY</button>' +
        '<div class="dmf-sec" style="margin-top:6px">Вариант 2 — свои ID тикетов</div>' +
        '<textarea id="dmf-ids" placeholder="23739196863&#10;23739196864&#10;… (любой разделитель)"></textarea>' +
        '<button class="dmf-btn" id="dmf-run-ids">▶ Проверить список</button>' +
        '<button class="dmf-btn" id="dmf-stop">⏹ Стоп — экспорт</button>' +
        '<label style="font-size:11px;color:rgba(200,220,255,.6);display:flex;align-items:center;gap:8px">Потоков (1–5): <input id="dmf-threads" type="number" min="1" max="5" value="' + DEFAULT_THREADS + '" style="width:48px;padding:4px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#e0ecff"></label>' +
        '<div style="font-size:10px;color:rgba(200,220,255,.4);line-height:1.4">Ищем тикеты, где цикл <b>Approved</b> → <b>Sent for processing</b> от pay_mena_* с комментарием «please attach the approved transaction…» был ' + Detector.MIN_CYCLES + '+ раз.</div>' +
      '</div>' +
      '<div id="dmf-main">' +
        '<div class="dmf-metrics">' +
          '<div class="dmf-metric"><div class="val" id="dmf-m-total">—</div><div class="lbl">Тикетов</div></div>' +
          '<div class="dmf-metric"><div class="val" id="dmf-m-done">0</div><div class="lbl">Проверено</div></div>' +
          '<div class="dmf-metric"><div class="val" id="dmf-m-found" style="color:#ff9a85">0</div><div class="lbl">Найдено</div></div>' +
          '<div class="dmf-metric"><div class="val" id="dmf-m-skip" style="color:#f93">0</div><div class="lbl">Пропущено</div></div>' +
        '</div>' +
        '<div class="dmf-sec">Найденные тикеты</div>' +
        '<div id="dmf-found"></div>' +
        '<div id="dmf-pb-wrap"><div id="dmf-pb"></div></div>' +
        '<div id="dmf-status">Готов к запуску</div>' +
      '</div>' +
    '</div>' +
  '</div>';
document.body.appendChild(wrap);

function $(id){ return document.getElementById(id); }
function togglePanel(){ wrap.classList.toggle('open'); }
fab.addEventListener('click', togglePanel);
$('dmf-close').addEventListener('click', function(){ wrap.classList.remove('open'); });

// ── Масштаб окна (для мелкого масштаба страницы, напр. 67%). Запоминается в localStorage.
var SCALE_MIN = 0.8, SCALE_MAX = 2, SCALE_STEP = 0.1, SCALE_KEY = 'dmf_scale';
var uiScale = 1;
try { uiScale = parseFloat(localStorage.getItem(SCALE_KEY)) || 1; } catch(e){}
function applyScale(v){
  uiScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 10) / 10));
  document.documentElement.style.setProperty('--dmf-z', String(uiScale));
  $('dmf-zoom-val').textContent = Math.round(uiScale * 100) + '%';
  try { localStorage.setItem(SCALE_KEY, String(uiScale)); } catch(e){}
}
$('dmf-zoom-in').addEventListener('click', function(){ applyScale(uiScale + SCALE_STEP); });
$('dmf-zoom-out').addEventListener('click', function(){ applyScale(uiScale - SCALE_STEP); });
$('dmf-zoom-val').addEventListener('click', function(){ applyScale(1); });
applyScale(uiScale);
wrap.addEventListener('click', function(e){ if(e.target === wrap) wrap.classList.remove('open'); });
document.addEventListener('keydown', function(e){
  if(e.altKey && (e.code === 'KeyD' || e.key === 'd' || e.key === 'D')){ e.preventDefault(); e.stopPropagation(); togglePanel(); }
}, true);

// ════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════
function setStatus(m){ $('dmf-status').textContent = m; }
function showToast(msg, type){
  var old = $('dmf-toast'); if(old) old.remove();
  var t = document.createElement('div');
  t.id = 'dmf-toast';
  t.style.background = type === 'ok' ? 'rgba(0,80,30,.92)' : type === 'err' ? 'rgba(90,15,15,.92)' : 'rgba(70,50,10,.92)';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 4500);
}
function updateApplyState(){
  var el = $('dmf-apply'); if(!el) return;
  if(_listUrl){
    el.className = 'dmf-field ok';
    el.textContent = '✅ Фильтр пойман' + (_listPayload && _listPayload.dateFrom ? ' (с ' + _listPayload.dateFrom + ')' : '');
  }
  $('dmf-run-apply').disabled = !_listUrl || state.running;
}
function setProgress(){
  var total = Math.max(state.total, state.expectedTotal || 0);
  $('dmf-m-total').textContent = total || '—';
  $('dmf-m-done').textContent = state.done;
  $('dmf-m-found').textContent = state.found.length;
  $('dmf-m-skip').textContent = state.skipped;
  $('dmf-pb').style.width = (total ? Math.round(state.done / total * 100) : 0) + '%';
}
function addFoundItem(f){
  var returns = f.cycles.map(function(c){ return c.returnedAt + ' ' + c.returnedBy; }).join('; ');
  var div = document.createElement('div');
  div.className = 'dmf-item';
  div.innerHTML = '<b>#' + esc(f.ticketId) + '</b> — возвратов: <b>' + f.count + '</b>' +
    '<div class="sub">' + esc(returns) + '</div>';
  var box = $('dmf-found');
  box.insertBefore(div, box.firstChild);
}
function setRunning(on){
  state.running = on;
  fab.classList.toggle('running', on);
  $('dmf-run-ids').disabled = on;
  $('dmf-stop').style.display = on ? 'block' : 'none';
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
        return {ticketId:String(t2.idTicket || t2.idTkt || ''), country:t2.nameCountry || ''};
      }).filter(function(t2){ return t2 && /^\d{5,}$/.test(t2.ticketId); });
      var size = pageSize || tickets.length || 1;
      console.log('[DMF] стр.' + pageNum + ': тикетов ' + tickets.length + ', total ' + total + ', is_polling ' + resp.is_polling + ', count ' + resp.count);

      if(!tickets.length){
        // Пустая страница: это конец, только если сервер так и говорит (или total это подтверждает).
        // Иначе сервер ещё не подготовил страницу — сигнализируем ошибку, чтобы её перезапросили.
        if(resp.otherData && resp.otherData.hasMore === false) return {ok:true, tickets:[], hasMore:false, total:total};
        if(total != null && (pageNum - 1) * size >= total) return {ok:true, tickets:[], hasMore:false, total:total};
        if(total == null && !resp.is_polling) return {ok:true, tickets:[], hasMore:false, total:total};
        return fail(resp.is_polling ? 'сервер ещё готовит страницу (is_polling)' : 'пустая страница, хотя total = ' + total);
      }
      var hasMore;
      if(resp.otherData && resp.otherData.hasMore === false) hasMore = false;  // PaymentSupport list
      else if(total != null) hasMore = pageNum * size < total;                 // ExtendedPaymentRequestList
      else hasMore = true;                                                     // идём до пустой страницы
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
  var res = Detector.analyzeHistory(resp.data);
  if(res.isDouble){
    var f = {ticketId:t.ticketId, country:t.country || '', count:res.count, cycles:res.cycles,
             lastStatus:res.lastStatus, lastDate:res.lastDate, lastAdmin:res.lastAdmin};
    state.found.push(f);
    addFoundItem(f);
  }
}

function getThreads(){
  var n = parseInt(($('dmf-threads') || {}).value, 10);
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
  state.source = source; state.total = 0; state.done = 0; state.skipped = 0; state.currentPage = 1;
  state.processedIds = {}; state.found = []; state._delay = DELAY_MIN; state._finishing = false; state.expectedTotal = 0;
  state.stopReason = ''; state.pagesDone = 0;
  state.startTime = Date.now();
  $('dmf-found').innerHTML = '';
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
  console.error('[DMF]', e);
  finishCollection('⚠ Ошибка: ' + (e && e.message));
}

function collectPage(attempt){
  attempt = attempt || 0;
  fetchListPage(state.currentPage).then(function(page){
    if(!state.running){ finishCollection(); return; }
    if(page.total != null) state.expectedTotal = page.total;
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

$('dmf-run-apply').addEventListener('click', function(){
  if(state.running) return;
  if(!_listUrl){ showToast('⚠ Сначала нажми APPLY в фильтре', 'warn'); return; }
  resetRun('apply');
  setStatus('Запуск...');
  collectPage();
});

$('dmf-run-ids').addEventListener('click', function(){
  if(state.running) return;
  var ids = parseIds($('dmf-ids').value);
  if(!ids.length){ showToast('⚠ Вставь ID тикетов (5+ цифр)', 'warn'); return; }
  resetRun('ids');
  state.total = ids.length;
  setProgress();
  var tickets = ids.map(function(id){ return {ticketId:id, country:''}; });
  runPool(tickets).then(function(){ finishCollection(); }).catch(onError);
});

$('dmf-stop').addEventListener('click', function(){
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
  console.log('[DMF ' + VERSION + '] Проверено: ' + state.done + ' | найдено: ' + state.found.length + ' | пропущено: ' + state.skipped + ' | ~' + mins + ' мин');
  if(!state.done){
    setStatus((reason ? reason + ' — ' : '') + 'нет проверенных тикетов');
    return;
  }
  try{
    var fn = buildXLSX();
    setStatus((reason ? reason + ' | ' : '✅ ') + fn + ' | проверено ' + state.done + ', найдено ' + state.found.length);
    showToast('✅ ' + fn + ' | найдено ' + state.found.length + ' из ' + state.done, 'ok');
  }catch(e){
    console.error('[DMF] Excel', e);
    setStatus('⚠ Ошибка Excel: ' + e.message);
  }
}

// ════════════════════════════════════════════════════
// EXCEL
// ════════════════════════════════════════════════════
var XC = {W:'FFFFFFFF', alt:'FFF4F8FB', DT:'FF1F1F1F', rB:'FFFFC7CE', rF:'FF9C0006', yB:'FFFFEB9C', yF:'FF9C6500'};
function xhdr(){ return {font:{bold:true,color:{rgb:'FF000000'},name:'Arial',sz:10},fill:{patternType:'solid',fgColor:{rgb:'FFEAD7DF'}},alignment:{horizontal:'center',vertical:'center',wrapText:true},border:{bottom:{style:'thin',color:{rgb:'FF999999'}},right:{style:'thin',color:{rgb:'FF999999'}}}}; }
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

function buildXLSX(){
  var wb = XLSX.utils.book_new();
  var found = state.found.slice().sort(function(a, b){ return b.count - a.count || String(a.ticketId).localeCompare(String(b.ticketId)); });

  // Лист 1 — тикеты
  makeSheet(wb, 'Двойные ошибки',
    ['Ticket ID','Country','Кол-во возвратов','Approved (дата — кто)','Возвраты (дата — pay_mena)','Текущий статус','Последнее изменение'],
    found.map(function(f){
      return [
        f.ticketId, f.country, f.count,
        f.cycles.map(function(c){ return c.approvedAt + ' — ' + c.approvedBy; }).join('\n'),
        f.cycles.map(function(c){ return c.returnedAt + ' — ' + withName(c.returnedBy, c.returnedByName); }).join('\n'),
        f.lastStatus,
        f.lastDate + (f.lastAdmin ? ' — ' + f.lastAdmin : '')
      ];
    }),
    [14, 10, 10, 34, 46, 34, 30],
    function(i){ return found[i].count > Detector.MIN_CYCLES ? [XC.rB, XC.rF] : null; }
  );

  // Лист 2 — детализация по циклам
  var detail = [];
  found.forEach(function(f){
    f.cycles.forEach(function(c, n){
      detail.push([f.ticketId, n + 1, c.approvedAt, c.approvedBy, c.approvedComment, c.returnedAt, c.returnedBy, c.returnedByName || agentName(c.returnedBy), c.comment]);
    });
  });
  makeSheet(wb, 'Детализация',
    ['Ticket ID','№ цикла','Approved — дата','Approved — кто','Approved — Inside Comment','Возврат — дата','Возврат — логин','Возврат — ФИО','Возврат — Inside Comment'],
    detail, [14, 8, 20, 24, 30, 20, 16, 24, 60]);

  // Лист 3 — сводка
  var byLogin = {};
  found.forEach(function(f){
    f.cycles.forEach(function(c){
      var k = c.returnedBy || '—';
      byLogin[k] = byLogin[k] || {returns:0, tickets:{}, name:c.returnedByName};
      byLogin[k].returns++;
      byLogin[k].tickets[f.ticketId] = 1;
    });
  });
  var summary = [
    ['Источник', state.source === 'apply' ? 'Фильтр (APPLY)' + (_listPayload && _listPayload.dateFrom ? ', с ' + _listPayload.dateFrom : '') : 'Список ID'],
    ['Проверено тикетов', state.done],
    ['Тикетов по фильтру (total)', state.expectedTotal || '—'],
    ['Пройдено страниц', state.source === 'apply' ? state.pagesDone : '—'],
    ['Сбор завершён', state.stopReason ? 'РАНЬШЕ ВРЕМЕНИ: ' + state.stopReason : (state.expectedTotal && state.done < state.expectedTotal ? 'остановлен вручную или не все тикеты загрузились' : 'полностью')],
    ['Найдено (' + Detector.MIN_CYCLES + '+ возврата)', found.length],
    ['Пропущено (ошибка загрузки)', state.skipped],
    ['Дата выгрузки', new Date().toLocaleString('ru-RU')],
    ['', ''],
    ['Возвраты по pay_mena', 'Возвратов / тикетов']
  ];
  Object.keys(byLogin).sort(function(a, b){ return byLogin[b].returns - byLogin[a].returns; }).forEach(function(k){
    summary.push([withName(k, byLogin[k].name), byLogin[k].returns + ' / ' + Object.keys(byLogin[k].tickets).length]);
  });
  makeSheet(wb, 'Сводка', ['Показатель', 'Значение'], summary, [40, 30]);

  var fn = 'double_mistakes_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fn);
  return fn;
}

setTimeout(updateApplyState, 1500);
console.log('%c[DMF ' + VERSION + '] загружен — Alt+D', 'color:#ff9a85;font-weight:bold');
})();
