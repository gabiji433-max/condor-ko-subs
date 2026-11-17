(() => {
  // 확장을 새로고침해서 다시 주입된 경우(__CNDR_FORCE)엔 패널 토글 대신 새 버전으로 교체
  const FORCE = window.__CNDR_FORCE; window.__CNDR_FORCE = false;
  if (window.__CNDR_RUNNING && !FORCE) {
    // 이미 켜져 있으면 아이콘 재클릭 = 패널 토글
    window.__CNDR_TOGGLE_PANEL && window.__CNDR_TOGGLE_PANEL();
    return;
  }
  const SUBS = window.__CNDR_SUBS;
  if (!SUBS) return;

  if (window !== window.top) return; // Prime Video 본편은 최상위 페이지에 있음

  // ---------- 저장 (사이트 localStorage, 실패해도 동작) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("cndr:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("cndr:" + k, JSON.stringify(v)); } catch {} },
  };

  // ---------- 본편 영상 찾기 ----------
  // 미리보기·예고편 영상을 피하려고, 길이가 가장 긴 영상을 본편으로 간주
  function pickVideo() {
    const vids = [...document.querySelectorAll("video")];
    let best = null;
    for (const v of vids) {
      const d = isFinite(v.duration) ? v.duration : 0;
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      if (!best || d > (isFinite(best.duration) ? best.duration : 0)) best = v;
    }
    return best;
  }

  // 이 프레임에 영상이 없으면 잠시 기다렸다가 그래도 없으면 종료 (다른 프레임이 담당)
  let tries = 0;
  const waitTimer = setInterval(() => {
    if (pickVideo()) { clearInterval(waitTimer); start(); }
    else if (++tries > 20) clearInterval(waitTimer);
  }, 500);

  const epName = (k) => { const m = k.match(/s(\d+)e(\d+)/); return m ? `시즌${m[1]} ${m[2]}화` : k; };
  // 회차 목록: 번역된 회차 (작업용은 전 회차)
  const ALL = []; for (const se of [1, 2]) for (let n = 1; n <= 10; n++) ALL.push(`s${se}e${n}`);
  const EPS = window.__CNDR_TTML ? ALL : Object.keys(SUBS).length ? Object.keys(SUBS) : ["s1e1"];
  const HAS_EN = Object.values(SUBS).some((cs) => cs.some((c) => c.en));

  function start() {
    window.__CNDR_RUNNING = true;
    // 확장을 새로고침하면 예전 스크립트가 페이지에 남아 계속 돈다.
    // DOM은 공유되므로, 마지막으로 켜진 인스턴스만 남기고 나머지는 스스로 꺼지게 한다.
    const myId = Math.random().toString(36).slice(2);
    document.documentElement.dataset.cndrOwner = myId;
    document.querySelectorAll("#cndr-root").forEach((el) => el.remove());
    const alive = () => document.documentElement.dataset.cndrOwner === myId;
    // 겹침 방지 기능이 없던 아주 예전 버전 자막이 남아 있어도 보이지 않게:
    // 최신 인스턴스의 자막(data-owner 일치)만 표시하는 스타일을 페이지에 걸어 둔다
    let guard = document.getElementById("cndr-guard");
    if (!guard) { guard = document.createElement("style"); guard.id = "cndr-guard"; document.documentElement.appendChild(guard); }
    guard.textContent = `#cndr-root:not([data-owner="${myId}"]){display:none!important}`;

    const state = {
      ep: store.get("ep", "s1e1"),
      mode: store.get("mode", "both"), // both | ko
      offsets: store.get("offsets", {}), // 에피소드별 오프셋(초). 자막시간 = 영상시간 + offset
      hidden: false,
      size: store.get("size", 30),
      // 자막 높이(영상 아래에서부터 %)
      pos: store.get("pos", 12),
      font: store.get("font", "cinema"),
      primeFix: store.get("primeFix", true), // Prime 재생 시간 보정
    };
    // 한글 자막 글꼴 (Mac에 설치된 글꼴 사용)
    const FONTS = {
      cinema: { family: '"a시네마M","aCinemaM","a시네마 M","a시네마B","aCinemaB","NanumGothic","Malgun Gothic",sans-serif', weight: 400 },
      nanum: { family: '"NanumGothic ExtraBold","NanumGothicExtraBold","NanumGothic","나눔고딕","Apple SD Gothic Neo",sans-serif', weight: 800 },
      pretendard: { family: '"Pretendard","Apple SD Gothic Neo",sans-serif', weight: 700 },
      sd: { family: '"Apple SD Gothic Neo",sans-serif', weight: 700 },
      myungjo: { family: '"AppleMyungjo","Nanum Myeongjo",serif', weight: 400 },
    };
    const DEFAULT_OFF = {}; // 에피소드별 기본 오프셋(Prime 영상 기준으로 맞춘 값)
    const off = () => (state.offsets[state.ep] ?? DEFAULT_OFF[state.ep] ?? 0);

    // ---------- Prime Video 시간 보정 ----------
    // Prime Video의 <video>.currentTime은 화면에 표시되는 재생 시간과 어긋나는 경우가 있음
    // (스트림 앞부분 오프셋). 플레이어 화면의 "경과 / 전체" 표시가 바뀌는 순간의 차이를 재서 보정.
    let primeDelta = null, lastShown = null;
    function shownTime() {
      const el = document.querySelector(".atvwebplayersdk-timeindicator-text");
      const m = el && el.textContent.match(/^\s*((?:\d+:)?\d+:\d\d)\s*\//);
      if (!m) return null;
      return m[1].split(":").reduce((a, x) => a * 60 + +x, 0);
    }
    function calibrate(v) {
      const t = shownTime();
      if (t == null || v.paused || v.seeking) { lastShown = t; return; }
      if (lastShown != null && t === lastShown + 1) {
        const d = v.currentTime - t;
        primeDelta = primeDelta == null || Math.abs(primeDelta - d) > 2 ? d : primeDelta * 0.8 + d * 0.2;
      }
      lastShown = t;
    }
    function baseTime(v) { return state.primeFix && primeDelta != null ? v.currentTime - primeDelta : v.currentTime; }
    function subTime(v) { return baseTime(v) + off(); }
    const cues = () => SUBS[state.ep] || [];

    // ---------- DOM ----------
    const root = document.createElement("div");
    root.id = "cndr-root";
    root.dataset.owner = myId;
    root.innerHTML = `
      <style>
        #cndr-root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
        #cndr-cap{position:absolute;left:50%;transform:translateX(-50%);text-align:center;width:90%;}
        #cndr-cap .ko{color:#fff;line-height:1.35;word-break:keep-all;letter-spacing:-0.01em;
          text-shadow:-1.5px -1.5px 0 #000,1.5px -1.5px 0 #000,-1.5px 1.5px 0 #000,1.5px 1.5px 0 #000,0 0 4px #000,0 2px 6px rgba(0,0,0,.8)}
        #cndr-cap .en{color:#e8e2b0;font-weight:500;line-height:1.3;margin-top:6px;text-shadow:0 0 3px #000,0 0 3px #000,0 1px 2px #000}
        #cndr-cap .it{font-style:italic}
        #cndr-cap .box{display:inline-block;max-width:100%}
        #cndr-panel{position:absolute;pointer-events:auto;background:rgba(20,20,24,.92);color:#eee;font-size:13px;border-radius:10px;padding:10px 12px;width:300px;box-shadow:0 4px 20px rgba(0,0,0,.5)}
        #cndr-panel button,#cndr-panel select{background:#333;color:#eee;border:1px solid #555;border-radius:5px;padding:3px 7px;font-size:12px;cursor:pointer}
        #cndr-panel button:hover{background:#444}
        #cndr-panel .row{display:flex;gap:5px;align-items:center;margin:5px 0;flex-wrap:wrap}
        #cndr-panel .muted{color:#999;font-size:11px;line-height:1.5}
        #cndr-panel .off{font-variant-numeric:tabular-nums;min-width:62px;text-align:center;font-weight:700}
        #cndr-panel .hd{display:flex;justify-content:space-between;align-items:center;cursor:move;font-weight:700;margin-bottom:4px}
        #cndr-sync{position:absolute;pointer-events:auto;background:rgba(20,20,24,.96);color:#eee;border-radius:10px;padding:10px;width:min(560px,80vw);max-height:60vh;overflow:auto;font-size:14px;display:none;box-shadow:0 4px 30px rgba(0,0,0,.6)}
        #cndr-sync .it{padding:6px 8px;border-radius:5px;cursor:pointer;display:flex;gap:8px}
        #cndr-sync .it:hover{background:#3a3a50}
        #cndr-sync .it.cur{outline:1px solid #8a8af0}
        #cndr-sync .t{color:#888;font-variant-numeric:tabular-nums;flex:none;width:52px}
        #cndr-toast{position:absolute;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:6px 14px;border-radius:6px;font-size:14px;display:none}
      </style>
      <div id="cndr-cap"></div>
      <div id="cndr-panel">
        <div class="hd"><span>한글 자막</span><button data-a="close" title="P 키로도 열고 닫기">숨김</button></div>
        <div class="row">
          <select data-a="ep">
            ${EPS.map((k) => `<option value="${k}">${epName(k)}${SUBS[k] && SUBS[k].some((x) => x.ko) ? "" : " (번역 전)"}</option>`).join("")}
          </select>
          <select data-a="mode"><option value="both">영어+한글</option><option value="ko">한글만</option></select>
          <button data-a="size-">가-</button><button data-a="size+">가+</button>
        </div>
        <div class="row">
          <span>글꼴</span>
          <select data-a="font">
            <option value="cinema">a시네마 (극장 자막체)</option>
            <option value="nanum">나눔고딕</option>
            <option value="pretendard">프리텐다드</option>
            <option value="sd">애플 산돌고딕</option>
            <option value="myungjo">명조 (시대극 느낌)</option>
          </select>
        </div>
        <div class="row">
          <button data-a="-5">-5초</button><button data-a="-0.5">-0.5</button>
          <span class="off"></span>
          <button data-a="+0.5">+0.5</button><button data-a="+5">+5초</button>
          <button data-a="reset" title="기본값으로">0</button>
        </div>
        <div class="row"><button data-a="sync">대사로 맞추기 (S)</button><button data-a="hide">자막 끄기 (H)</button></div>
        <div class="row"><span>높이</span><button data-a="up" title="영어 CC와 겹치면 위로">▲ 위로</button><button data-a="down">▼ 아래로</button><span class="pos"></span></div>
        <div class="row"><label style="display:flex;gap:4px;align-items:center;cursor:pointer"><input type="checkbox" data-a="primeFix">재생 시간 보정</label><span class="pst muted"></span><button data-a="diag" title="문제가 있을 때 눌러서 제보에 붙여 주세요">진단 복사</button></div>
        <div class="muted">
          자막이 늦게 나오면 +, 빨리 나오면 −<br>
          [ ] ±0.5초 · Shift+[ ] ±5초 · S 맞추기 · H 끄기 · K 언어 · P 패널
        </div>
      </div>
      <div id="cndr-sync"></div>
      <div id="cndr-toast"></div>`;
    const $ = (s) => root.querySelector(s);
    const cap = $("#cndr-cap"), panel = $("#cndr-panel"), syncBox = $("#cndr-sync"), toast = $("#cndr-toast");
    $('[data-a="ep"]').value = state.ep;
    if (!EPS.includes(state.ep)) state.ep = EPS[0];
    $('[data-a="ep"]').value = state.ep;
    $('[data-a="mode"]').value = state.mode;
    // 영어 자막이 없는 배포판이면 언어 선택 숨김
    if (!HAS_EN) $('[data-a="mode"]').style.display = "none";
    $('[data-a="font"]').value = state.font;
    $('[data-a="primeFix"]').checked = state.primeFix;

    function mount() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const host = fs && fs.tagName !== "VIDEO" ? fs : document.body || document.documentElement;
      if (root.parentNode !== host) host.appendChild(root);
    }
    mount();
    document.addEventListener("fullscreenchange", () => setTimeout(mount, 50));
    document.addEventListener("webkitfullscreenchange", () => setTimeout(mount, 50));

    let toastT;
    function say(msg) {
      toast.textContent = msg; toast.style.display = "block";
      clearTimeout(toastT); toastT = setTimeout(() => (toast.style.display = "none"), 1500);
    }
    const fmtOff = (o) => (o >= 0 ? "+" : "−") + Math.abs(o).toFixed(1) + "초";
    const fmtT = (t) => { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };

    function save() {
      store.set("ep", state.ep); store.set("mode", state.mode);
      store.set("offsets", state.offsets); store.set("size", state.size); store.set("font", state.font); store.set("pos", state.pos); store.set("primeFix", state.primeFix);
    }
    function shift(d) {
      state.offsets[state.ep] = Math.round((off() + d) * 10) / 10;
      save(); say("자막 " + fmtOff(off()));
    }

    // ---------- 대사로 맞추기: 지금 들린 대사를 목록에서 고르면 오프셋 재계산 ----------
    function openSync() {
      const v = pickVideo(); if (!v) return;
      const now = subTime(v);
      const list = cues().filter((c) => c.s > now - 240 && c.s < now + 60);
      syncBox.innerHTML = `<div style="margin-bottom:6px;font-weight:700">방금 들린 대사를 누르세요 <span style="color:#999;font-weight:400">(Esc 닫기)</span></div>`;
      let curEl = null;
      for (const c of list) {
        const d = document.createElement("div");
        d.className = "it";
        if (!curEl && c.s >= now - 1) { d.classList.add("cur"); curEl = d; }
        d.innerHTML = `<span class="t">${fmtT(c.s)}</span><span></span>`;
        d.lastChild.textContent = (c.ko || "").replace(/\n/g, " ") + (c.en ? "  ·  " + c.en.replace(/\n/g, " ") : "");
        d.onclick = () => {
          const vv = pickVideo();
          { const t = baseTime(vv); state.offsets[state.ep] = Math.round((c.s - t + 0.3) * 10) / 10; }
          save(); closeSync(); say("맞췄어요 " + fmtOff(off()));
        };
        syncBox.appendChild(d);
      }
      if (!list.length) syncBox.insertAdjacentHTML("beforeend", "<div class='muted'>근처에 대사가 없어요. ±5초로 조정해 보세요.</div>");
      syncBox.style.display = "block";
      (curEl || syncBox.lastChild).scrollIntoView({ block: "center" });
    }
    function closeSync() { syncBox.style.display = "none"; }

    function copyDiag() {
      const v = pickVideo();
      const d = {
        step: "cndr-diag", ver: "0.1.0", ep: state.ep, off: off(), primeFix: state.primeFix, primeDelta, shown: shownTime(),
        video: v ? { t: v.currentTime, dur: v.duration, base: baseTime(v) } : null,
        ccHint: "콘솔에 [CNDR] 로그 확인",
        videos: [...document.querySelectorAll("video")].map((x) => ({ t: x.currentTime, dur: x.duration, w: x.getBoundingClientRect().width })),
      };
      const s = JSON.stringify(d, null, 1);
      const ta = document.createElement("textarea"); ta.value = s; ta.style.cssText = "position:fixed;opacity:0";
      root.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch {}
      ta.remove(); console.log("[CNDR 진단]", s); say(ok ? "진단 정보 복사됨 — 제보할 때 붙여 주세요" : "복사 실패 — 콘솔에 [CNDR 진단] 출력함");
    }

    function togglePanel() { panel.style.display = panel.style.display === "none" ? "block" : "none"; }
    window.__CNDR_TOGGLE_PANEL = togglePanel;

    panel.addEventListener("click", (e) => {
      const a = e.target.dataset && e.target.dataset.a; if (!a) return;
      if (a === "close") togglePanel();
      else if (a === "sync") openSync();
      else if (a === "diag") copyDiag();
      else if (a === "hide") { state.hidden = !state.hidden; say(state.hidden ? "자막 끔" : "자막 켬"); }
      else if (a === "reset") { delete state.offsets[state.ep]; save(); say("자막 기본값 " + fmtOff(off())); }
      else if (a === "size+") { state.size = Math.min(60, state.size + 2); save(); }
      else if (a === "up") { state.pos = Math.min(80, state.pos + 2); save(); }
      else if (a === "down") { state.pos = Math.max(0, state.pos - 2); save(); }
      else if (a === "size-") { state.size = Math.max(14, state.size - 2); save(); }
      else if (!isNaN(parseFloat(a))) shift(parseFloat(a));
    });
    panel.addEventListener("change", (e) => {
      const a = e.target.dataset.a;
      if (a === "ep") { state.ep = e.target.value; save(); say(epName(state.ep) + " 자막"); }
      if (a === "mode") { state.mode = e.target.value; save(); }
      if (a === "font") { state.font = e.target.value; save(); lastKey = ""; }
      if (a === "primeFix") { state.primeFix = e.target.checked; save(); say(state.primeFix ? "재생 시간 보정 켬" : "재생 시간 보정 끔"); }
    });

    // 패널 드래그
    panel.querySelector(".hd").addEventListener("mousedown", (e) => {
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = (ev) => { panelPos = { x: ev.clientX - dx, y: ev.clientY - dy }; store.set("panelPos", panelPos); };
      const up = () => { removeEventListener("mousemove", mv, true); removeEventListener("mouseup", up, true); };
      addEventListener("mousemove", mv, true); addEventListener("mouseup", up, true);
      e.preventDefault();
    });
    let panelPos = store.get("panelPos", null);

    // 단축키 (입력창에서는 무시, 우리 키만 가로챔)
    window.addEventListener("keydown", (e) => {
      if (!alive()) return;
      const t = e.target;
      if (t && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      let hit = true;
      if (e.code === "BracketLeft") shift(e.shiftKey ? -5 : -0.5);
      else if (e.code === "BracketRight") shift(e.shiftKey ? 5 : 0.5);
      else if (e.code === "KeyS") (syncBox.style.display === "block" ? closeSync() : openSync());
      else if (e.code === "KeyH") { state.hidden = !state.hidden; say(state.hidden ? "자막 끔" : "자막 켬"); }
      else if (e.code === "KeyK") { state.mode = state.mode === "both" ? "ko" : "both"; $('[data-a="mode"]').value = state.mode; save(); say(state.mode === "ko" ? "한글만" : "영어+한글"); }
      else if (e.code === "KeyP") togglePanel();
      else if (e.code === "Escape" && syncBox.style.display === "block") closeSync();
      else hit = false;
      if (hit) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // ---------- 렌더 루프 ----------
    let lastKey = "", ci = 0;
    function find(t) {
      const cs = cues(); if (!cs.length) return null;
      if (ci >= cs.length || cs[ci].s > t) ci = 0;
      while (ci < cs.length - 1 && cs[ci + 1].s <= t) ci++;
      // 위에서 선형 탐색이 느리지 않도록 큰 점프는 이진 탐색
      if (Math.abs(cs[ci].s - t) > 60) {
        let lo = 0, hi = cs.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cs[m].s <= t) lo = m; else hi = m - 1; }
        ci = lo;
      }
      const c = cs[ci];
      return c && c.s <= t && t <= c.e ? c : null;
    }
    function tick() {
      if (!alive()) { root.remove(); return; } // 새 인스턴스가 켜지면 종료
      mount();
      const v = pickVideo();
      if (v) {
        const r = v.getBoundingClientRect();
        // 자막 위치: 영상 하단 12% 지점
        cap.style.bottom = Math.max(0, innerHeight - r.bottom + r.height * state.pos / 100) + "px";
        cap.style.left = r.left + r.width / 2 + "px";
        cap.style.width = r.width * 0.8 + "px";
        const scale = Math.max(0.6, Math.min(1.6, r.width / 1280));
        const fs = state.size * scale;
        if (!panelPos) { panel.style.left = r.left + 16 + "px"; panel.style.top = r.top + 16 + "px"; }
        else { panel.style.left = panelPos.x + "px"; panel.style.top = panelPos.y + "px"; }
        syncBox.style.left = r.left + r.width / 2 - Math.min(560, innerWidth * 0.8) / 2 + "px";
        syncBox.style.top = r.top + r.height * 0.1 + "px";
        $(".off").textContent = fmtOff(off());
        $(".pos").textContent = state.pos + "%";
        $(".pst").textContent = !state.primeFix ? "" : primeDelta == null ? "(측정 중)" : "작동 중";

        calibrate(v);
        const c = state.hidden ? null : find(subTime(v));
        const enText = state.hidden || state.mode !== "both" || !c ? "" : c.en || "";
        const key = (c ? c.s : "none") + "|" + enText + state.mode + fs + state.font + r.width;
        if (key !== lastKey) {
          lastKey = key;
          if (!c && !enText) cap.innerHTML = "";
          else {
            const it = c && c.it ? " it" : "";
            const f = FONTS[state.font] || FONTS.cinema;
            const ko = c && c.ko ? `<div class="ko${it}" style="font-size:${fs}px;font-family:${f.family.replace(/"/g, "'")};font-weight:${f.weight}"></div>` : "";
            const en = enText ? `<div class="en${it}" style="font-size:${fs * 0.6}px"></div>` : "";
            cap.innerHTML = `<div class="box">${ko}${en}</div>`;
            // 번역문의 줄 구분은 무시하고 한 줄로 이어 붙임 → 화면 폭이 모자랄 때만 자연스럽게 줄바꿈
            // 두 사람이 주고받는 대사(-로 시작)는 줄을 나눠 표시
            // 화면 글자(extra)는 줄바꿈 그대로
            // 일반 대사는 한 줄로 이어 붙이고, 주고받는 대사(-A / -B)만 화자별로 줄바꿈
            const flow = (t) => {
              if (c && c.extra) return t;
              if (/^\s*-/m.test(t) && t.includes("\n"))
                return t.split(/\n(?=\s*-)/).map((x) => x.replace(/\s*\n\s*/g, " ")).join("\n");
              return t.replace(/\s*\n\s*/g, " ");
            };
            if (ko) { const k = cap.querySelector(".ko"); k.textContent = flow(c.ko); k.style.whiteSpace = "pre-line"; }
            if (en) { const e = cap.querySelector(".en"); e.textContent = flow(enText); e.style.whiteSpace = "pre-line"; }
          }
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    say("한글 자막 켜짐 · " + epName(state.ep));
  }
})();
