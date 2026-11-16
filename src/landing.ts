// The page a person sees when they open mcp.plivo.com in a browser. One self-contained document: its style and
// scripts are inline and the policy names them by hash, so nothing else can run on it.
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plivo MCP server</title>
<meta name="description" content="Connect Claude, Cursor or any MCP client to your Plivo account with one URL.">
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Sora:wght@400;500;600&display=swap" rel="stylesheet">
<script>try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<style>
:root{color-scheme:light;--bg:#fff;--text:#404046;--accent:#323dfe;--line:#ececf1;--brand:#000;--line-strong:#dcdce3;--muted:#515157;--strong:#18181e;--head:#101828;--faint:#9a9aa3;--subtle:#717177;--code-bg:#f2f3f8;--line-2:#e0e0e6;--pre:#1f2328;--tok-k:#953800;--tok-s:#0a3069;--tok-p:#0550ae;--icon:#8a8a93;--soft:#fafafc;--note-line:#e5e5ea;--warn-line:#fde68a;--warn-bg:#fffbeb;--warn-text:#713f12;--warn-icon:#a16207;--row:#efeff5}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#0e0f13;--text:#c3c4ce;--accent:#8d96ff;--line:#23252e;--brand:#fff;--line-strong:#343641;--muted:#a6a7b2;--strong:#f1f1f4;--head:#f5f5f8;--faint:#6c6e7a;--subtle:#8d8f9b;--code-bg:#1c1e27;--line-2:#2d2f3a;--pre:#e3e4eb;--tok-k:#ffab70;--tok-s:#9ecbff;--tok-p:#79b8ff;--icon:#7f818d;--soft:#14151b;--note-line:#2b2d37;--warn-line:#5a4712;--warn-bg:#221b09;--warn-text:#f2d88a;--warn-icon:#e0b341;--row:#1e2029}}
:root[data-theme=dark]{color-scheme:dark;--bg:#0e0f13;--text:#c3c4ce;--accent:#8d96ff;--line:#23252e;--brand:#fff;--line-strong:#343641;--muted:#a6a7b2;--strong:#f1f1f4;--head:#f5f5f8;--faint:#6c6e7a;--subtle:#8d8f9b;--code-bg:#1c1e27;--line-2:#2d2f3a;--pre:#e3e4eb;--tok-k:#ffab70;--tok-s:#9ecbff;--tok-p:#79b8ff;--icon:#7f818d;--soft:#14151b;--note-line:#2b2d37;--warn-line:#5a4712;--warn-bg:#221b09;--warn-text:#f2d88a;--warn-icon:#e0b341;--row:#1e2029}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:400 16px/28px Inter,-apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
svg{display:block}

.top{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line)}
.top-in{max-width:1088px;margin:0 auto;padding:0 32px;height:64px;display:flex;align-items:center}
.brand{display:flex;align-items:center;gap:14px;color:var(--brand)}
.brand svg{height:26px;width:53px}
.brand span{padding-left:14px;border-left:1px solid var(--line-strong);font:500 14px/20px Inter,sans-serif;color:var(--muted)}
.top nav{margin-left:auto;display:flex;gap:28px;font:500 14px/20px Inter,sans-serif;color:var(--muted)}
.top nav a:hover{color:var(--strong)}

.page{max-width:1088px;margin:0 auto;padding:0 32px;display:grid;grid-template-columns:minmax(0,760px) 200px;justify-content:space-between;column-gap:64px}
.main{padding:64px 0 0;min-width:0}
h1{margin:0;font:600 40px/48px Sora,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.8px;color:var(--strong)}
.lede{margin:16px 0 0;font-size:18px;line-height:30px;color:var(--muted)}
.prose{margin-top:32px}
.prose p{margin:0 0 20px}
.prose h2,.prose h3{font-family:Sora,ui-sans-serif,system-ui,sans-serif;font-weight:600;color:var(--head);scroll-margin-top:96px}
.prose h2{margin:56px 0 16px;padding-top:36px;border-top:1px solid var(--line);font-size:26px;line-height:34px;letter-spacing:-.5px}
.prose h3{margin:32px 0 10px;font-size:18px;line-height:28px;letter-spacing:-.2px}
.prose a{color:var(--accent);font-weight:500}
.prose a:hover{text-decoration:underline;text-underline-offset:3px}
.prose strong{font-weight:600;color:var(--strong)}
.prose ul,.prose ol{margin:0 0 20px;padding:0;list-style:none}
.prose li{position:relative;margin:8px 0;padding-left:28px}
.prose ul>li::before{content:"";position:absolute;left:8px;top:12px;width:5px;height:5px;border-radius:50%;background:var(--faint)}
.prose ol{counter-reset:n}
.prose ol>li{counter-increment:n}
.prose ol>li::before{content:counter(n) ".";position:absolute;left:4px;color:var(--subtle);font-weight:500}
code{font:500 14px/21px "JetBrains Mono",ui-monospace,Menlo,monospace}
:not(pre)>code{padding:2px 6px;border-radius:2px;background:var(--code-bg);color:var(--head);font-size:13.5px;overflow-wrap:anywhere}

.cb{position:relative;margin:16px 0 20px;border:1px solid var(--line-2);border-radius:2px;background:var(--bg)}
.cb pre{margin:0;padding:14px 60px 14px 16px;overflow-x:auto;color:var(--pre);line-height:24px}
.cb pre code{font-weight:400;line-height:24px;white-space:pre}
.cb .k{color:var(--tok-k)}.cb .s{color:var(--tok-s)}.cb .p{color:var(--tok-p)}
.copy{position:absolute;top:11px;right:12px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:2px;color:var(--icon)}
.copy:hover{background:var(--code-bg);color:var(--text)}
.copy svg{width:16px;height:16px}
.copy.ok{color:var(--accent)}
.hint{margin:-8px 0 0;font-size:14px;line-height:22px;color:var(--subtle)}

.tablist{display:flex;gap:28px;margin:0 0 20px;padding:0;list-style:none;border-bottom:1px solid var(--line-2);overflow-x:auto}
.prose .tablist li{display:flex;margin:0;padding:0}.prose .tablist li::before{display:none}
.tablist button{margin-bottom:-1px;padding:10px 0;border-bottom:2px solid transparent;font:500 14px/24px Inter,sans-serif;color:var(--muted);white-space:nowrap}
.tablist button:hover{color:var(--strong)}
.tablist button[aria-selected=true]{color:var(--accent);border-color:currentColor;font-weight:600}
.panel[hidden]{display:none}
.panel>:last-child{margin-bottom:0}
.tabs{margin:24px 0 0}

.callout{display:flex;gap:12px;margin:20px 0;padding:14px 18px;border:1px solid var(--note-line);border-radius:2px;background:var(--soft);color:var(--text);font-size:14px;line-height:22px}
.callout svg{flex:none;width:18px;height:18px;margin-top:2px;color:var(--subtle)}
.callout p{margin:0}
.callout.warn{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn-text)}
.callout.warn svg{color:var(--warn-icon)}

.tw{overflow-x:auto;margin:16px 0 24px}
table{width:100%;border-collapse:collapse;font-size:15px;line-height:24px;text-align:left}
th{padding:0 16px 10px 0;border-bottom:1px solid var(--line-strong);font:600 13px/20px Inter,sans-serif;color:var(--muted);white-space:nowrap}
td{padding:12px 16px 12px 0;border-bottom:1px solid var(--row);vertical-align:top}
td:first-child{white-space:nowrap;color:var(--strong)}
td:last-child,th:last-child{padding-right:0}
.ex{color:var(--subtle)}

.foot{display:flex;flex-wrap:wrap;gap:28px;margin-top:80px;padding:28px 0 72px;border-top:1px solid var(--line);font:400 14px/20px Inter,sans-serif;color:var(--subtle)}
.foot a:hover{color:var(--strong)}
.foot span{margin-right:auto}

.toc{position:sticky;top:64px;align-self:start;max-height:calc(100vh - 64px);overflow-y:auto;padding:76px 0 40px}
.toc p{margin:0 0 10px;font:600 13px/20px Inter,sans-serif;color:var(--strong)}
.toc ul{list-style:none;margin:0;padding:0;border-left:1px solid var(--line)}
.toc a{display:block;margin-left:-1px;padding:5px 0 5px 16px;border-left:1px solid transparent;font:400 14px/20px Inter,sans-serif;color:var(--subtle)}
.toc a:hover{color:var(--strong)}
.toc a.on{color:var(--accent);border-color:var(--accent);font-weight:500}

.theme{margin-left:20px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line-2);border-radius:2px;color:var(--muted)}
.theme:hover{color:var(--strong);background:var(--code-bg)}
.theme svg{width:16px;height:16px}
.theme .moon{display:none}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .theme .sun{display:none}:root:not([data-theme=light]) .theme .moon{display:block}}
:root[data-theme=dark] .theme .sun{display:none}:root[data-theme=dark] .theme .moon{display:block}
@media (max-width:1023px){.page{display:block}.toc{display:none}}
@media (max-width:640px){
  .top-in,.page{padding:0 20px}
  .top nav{gap:20px}
  .main{padding-top:40px}
  h1{font-size:30px;line-height:38px;letter-spacing:-.6px}
  .lede{font-size:17px;line-height:28px}
  .prose h2{margin-top:48px;padding-top:32px;font-size:22px;line-height:30px}
  .tablist{gap:22px}
  table{font-size:14px}
  td:first-child{white-space:normal}
  .stack td,.stack th{display:block;padding-right:0}
  .stack thead{display:none}
  .stack td:first-child{padding-bottom:0;border-bottom:0;font-weight:600}
  .stack td:last-child{padding-top:2px}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}

:root{--cta-hover:#323dfe;--cta-hover-text:#fff;--bg:#fff;--text:hsl(240 5% 26%);--accent:hsl(235 99% 59%);--line:hsl(240 6% 90%);--brand:hsl(240 10% 4%);--line-strong:hsl(240 6% 80%);--code-bg:hsl(240 5% 96%);--line-2:hsl(240 6% 90%);--note-line:hsl(240 6% 90%);--btn:hsl(240 10% 4%);--btn-hover:hsl(240 6% 22%);--btn-text:#fff;--muted:hsl(240 4% 42%);--strong:hsl(240 10% 4%);--head:hsl(240 10% 4%);--faint:hsl(240 5% 65%);--subtle:hsl(240 4% 44%);--pre:hsl(240 10% 12%);--icon:hsl(240 4% 44%);--soft:hsl(240 5% 98%);--row:hsl(240 6% 93%);--ok:#0f7b4f;--dot:hsl(235 99% 59%)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:hsl(225 18% 5%);--text:hsl(240 5% 80%);--accent:hsl(235.6 100% 74%);--line:hsl(225 12% 18%);--brand:hsl(240 5% 96%);--line-strong:hsl(225 10% 28%);--code-bg:hsl(225 14% 11%);--line-2:hsl(225 12% 18%);--note-line:hsl(225 12% 18%);--btn:hsl(240 5% 96%);--btn-hover:#fff;--btn-text:hsl(225 18% 5%);--muted:hsl(240 4% 64%);--strong:hsl(240 5% 96%);--head:hsl(240 5% 96%);--faint:hsl(225 8% 42%);--subtle:hsl(240 4% 58%);--pre:hsl(240 5% 90%);--icon:hsl(240 4% 58%);--soft:hsl(225 15% 8%);--row:hsl(225 12% 14%);--ok:#5fd3a0;--dot:hsl(235.6 100% 65.5%)}}
:root[data-theme=dark]{--bg:hsl(225 18% 5%);--text:hsl(240 5% 80%);--accent:hsl(235.6 100% 74%);--line:hsl(225 12% 18%);--brand:hsl(240 5% 96%);--line-strong:hsl(225 10% 28%);--code-bg:hsl(225 14% 11%);--line-2:hsl(225 12% 18%);--note-line:hsl(225 12% 18%);--btn:hsl(240 5% 96%);--btn-hover:#fff;--btn-text:hsl(225 18% 5%);--muted:hsl(240 4% 64%);--strong:hsl(240 5% 96%);--head:hsl(240 5% 96%);--faint:hsl(225 8% 42%);--subtle:hsl(240 4% 58%);--pre:hsl(240 5% 90%);--icon:hsl(240 4% 58%);--soft:hsl(225 15% 8%);--row:hsl(225 12% 14%);--ok:#5fd3a0;--dot:hsl(235.6 100% 65.5%)}
.brand span{font:400 11px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--subtle)}
.top nav{font:400 13px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.hero{border-bottom:1px solid var(--line)}
.hero-in{max-width:1088px;margin:0 auto;padding:60px 32px 60px;display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:64px;align-items:center}
.hero h1{font:400 52px/1.04 Sora,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.04em;color:var(--strong)}
.hero .lede{max-width:540px;margin-top:20px;font-size:17px;line-height:28px;color:var(--muted)}
.urlbox{display:flex;align-items:center;gap:14px;margin-top:32px;padding:7px 7px 7px 16px;border:1px solid var(--line-strong);border-radius:2px;background:var(--soft)}
.urlbox-label{flex:none;padding-right:14px;border-right:1px solid var(--line);font:400 11px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--subtle)}
.urlbox code{flex:1;min-width:0;padding:0;background:none;font-size:15px;line-height:24px;font-weight:400;color:var(--strong);overflow-wrap:anywhere}
.copy-text{position:static;flex:none;width:auto;height:36px;gap:8px;padding:0 14px;border:1px solid var(--line-strong);border-radius:2px;background:var(--bg);color:var(--strong);font:500 11px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}
.copy-text{transition:background-color .15s ease-in-out,color .15s ease-in-out,border-color .15s ease-in-out}
.copy-text.ok{color:var(--strong)}
.copy-text:hover,.copy-text.ok:hover{border-color:var(--cta-hover);background:var(--cta-hover);color:var(--cta-hover-text)}
.copy-text svg{width:14px;height:14px}
.copy-text .c2,.copy-text.ok .c1{display:none}.copy-text.ok .c2{display:inline}
.hero .hint{margin:14px 0 0;font:400 12px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--subtle)}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
.btn{display:inline-flex;align-items:center;gap:10px;height:42px;padding:0 18px;border:1px solid var(--line-strong);border-radius:2px;font:500 12px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--strong)}
.btn{transition:background-color .15s ease-in-out,color .15s ease-in-out,border-color .15s ease-in-out,transform 50ms ease-in-out}
.btn:hover{border-color:var(--cta-hover);background:var(--cta-hover);color:var(--cta-hover-text)}
.btn:active{transform:translateY(1px)}
.btn-primary{border-color:var(--btn);background:var(--btn);color:var(--btn-text)}
.btn-primary::after{content:"\\2192";letter-spacing:0;font-size:14px;transition:transform .15s}
.btn-primary:hover::after{transform:translateX(2px)}
.demo{position:relative;overflow:hidden;margin:0;border:1px solid var(--line-strong);border-radius:2px;background:var(--soft);font-size:14px;line-height:22px}
.demo-alt{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.demo-h{display:flex;padding:9px 14px;border-bottom:1px solid var(--line);font:400 12px/18px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.demo-h span{display:flex;align-items:center;gap:9px}
.demo-h i{width:6px;height:6px;border-radius:50%;background:var(--dot)}
.demo-b{padding:18px 16px 16px}
.say{margin:0 0 14px;color:var(--strong)}
.say .who{margin-right:4px;font:400 12px/22px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}
.say .rest{visibility:hidden}
.caret{position:relative;display:none}
.caret::after{content:"";position:absolute;left:1px;top:.12em;width:2px;height:1.15em;background:var(--accent);animation:blink 1s steps(1) infinite}
.steps{list-style:none;margin:0 0 16px;padding:0;border-top:1px solid var(--line)}
.steps li{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}
.steps code{padding:0;background:none;font-size:13px;font-weight:400;color:var(--strong)}
.steps .note{margin-left:auto;font:400 12px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--subtle)}
.ico{flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center;color:var(--ok)}
.ico svg{display:none;width:14px;height:14px}
.ico i{box-sizing:border-box;width:7px;height:7px;border-radius:50%;background:var(--dot);animation:pulse 1.6s ease-in-out infinite}
.is-done .ico svg{display:block}.is-done .ico i{display:none}
.is-run .ico i{width:12px;height:12px;border:1.5px solid var(--line-strong);border-top-color:var(--dot);background:none;animation:spin .8s linear infinite}
@keyframes pulse{50%{opacity:.3}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes blink{50%{opacity:0}}
@keyframes pop{0%{transform:scale(.5);opacity:0}100%{transform:none;opacity:1}}
.stage{display:grid}
.stage>*{grid-area:1/1}
.approve{padding:14px 16px;border:1px solid var(--line-strong);border-radius:2px;background:var(--bg)}
.approve p{margin:0}
.approve-t{font-weight:600;color:var(--strong)}
.approve-d{margin-top:4px!important;color:var(--muted)}
.approve-d strong,.receipt strong{font-weight:500;color:var(--strong);white-space:nowrap}
.approve-b{display:flex;gap:8px;margin-top:12px}
.pill{padding:4px 12px;border:1px solid var(--line-strong);border-radius:2px;font:500 11px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--strong)}
.pill-on{border-color:var(--btn);background:var(--btn);color:var(--btn-text)}
.receipt{align-self:start;margin:0;padding:10px 16px;border-left:2px solid var(--ok);color:var(--muted)}
.ptr{position:absolute;left:0;top:0;width:18px;height:18px;color:var(--strong);stroke:var(--bg);opacity:0;pointer-events:none}
.demo .off{opacity:0;visibility:hidden}
.ghost{display:none}
.demo.typing .caret{display:inline}
.demo.live .demo-b{transition:opacity .45s ease}
.demo.live .demo-b.out{opacity:0}
.demo.live .steps li,.demo.live .stage>*{transition:opacity .4s ease,transform .5s cubic-bezier(.2,.7,.2,1),visibility 0s}
.demo.live .off{transform:translateY(8px);transition:opacity .3s ease,transform .4s ease,visibility 0s .4s}
.demo.live .steps li.off{opacity:1;visibility:visible;transform:none}
.demo.live .steps code,.demo.live .steps .note{transition:color .35s ease}
.demo.live li.off code,.demo.live li.off .note{color:transparent;background:linear-gradient(var(--row),var(--row)) 0 50%/100% 8px no-repeat}
.demo.live li.off .ico i{width:12px;height:12px;border:1.5px solid var(--row);background:none;animation:none}
.demo.live .ghost{display:block;padding:18px 16px;border:1px dashed var(--line-strong);border-radius:2px;opacity:0;transition:opacity .35s ease}
.demo.live .approve.off:not(.gone)~.ghost{opacity:1}
.ghost i{display:block;height:8px;margin-bottom:12px;background:var(--row)}
.ghost i:nth-child(1){width:42%}.ghost i:nth-child(2){width:92%}.ghost i:nth-child(3){width:64%;margin-bottom:18px}
.ghost i:nth-child(n+4){display:inline-block;width:84px;height:28px;margin:0 8px 0 0;border:1px solid var(--row);background:none}
.ghost i:nth-child(5){width:62px}
.demo.live .approve.off.gone{transform:scaleY(.7);transform-origin:50% 0}
.demo.live .is-done .ico svg{animation:pop .3s cubic-bezier(.2,.7,.2,1)}
.demo.live .pill-on{transition:transform .15s ease,background-color .15s ease,border-color .15s ease,box-shadow .15s ease}
.demo.live .pill-on.press{transform:scale(.93);border-color:var(--btn-hover);background:var(--btn-hover);box-shadow:0 0 0 3px var(--line-strong)}
.demo.live .ptr{transition:transform .75s cubic-bezier(.3,.1,.2,1),opacity .3s ease}
.demo.live .ptr.on{opacity:1}
.demo.held *,.demo.held *::after{animation-play-state:paused!important}
.demo-f{margin:0;padding:9px 14px;border-top:1px solid var(--line);font:400 12px/18px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}
.facts{max-width:1088px;margin:0 auto;padding:0 32px 64px}
.facts dl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin:0;border:1px solid var(--line-strong);border-radius:2px;background:var(--line)}
.facts dl div{padding:22px 24px 26px;background:var(--bg)}
.facts dt{font:400 11px/16px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--subtle)}
.facts dd{margin:0}
.facts .v{margin-top:18px;font:400 46px/1 Sora,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.04em;font-variant-numeric:tabular-nums;color:var(--strong)}
.facts .v b{font-weight:400;color:var(--accent)}
.facts .v small{margin-left:8px;font:400 13px/1 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;color:var(--subtle)}
.facts .d{margin-top:14px;max-width:210px;font-size:14px;line-height:22px;color:var(--muted)}
.main{padding-top:8px}
.prose{margin-top:0}
.prose h2{font:500 28px/1.15 Sora,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.03em;color:var(--strong)}
.prose>h2:first-child{border-top:0;margin-top:28px}
.prose h3{color:var(--strong)}
th{font:400 11px/16px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--subtle)}
.tablist button{font:400 13px/24px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.tablist button[aria-selected=true]{color:var(--strong);border-color:var(--dot);font-weight:500}
.toc{padding-top:76px}
.toc p{font:400 11px/16px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--subtle)}
.toc a.on{color:var(--strong);border-color:var(--dot)}
.foot{font:400 12px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
@media (max-width:1023px){.hero-in{grid-template-columns:minmax(0,1fr);gap:40px}.demo{max-width:480px}}
@media (max-width:640px){
  .hero-in{padding:36px 20px 40px}
  .hero h1{font-size:36px}
  .urlbox{flex-wrap:wrap;padding:12px}
  .urlbox-label{width:100%;padding:0;border:0}
  .copy-text{width:100%;justify-content:center}
  .cta .btn{flex:1 1 100%;justify-content:center}
  .facts{padding:0 20px 40px}
  .facts dl{grid-template-columns:repeat(2,minmax(0,1fr))}
  .facts dl div{padding:16px 14px 18px}
  .facts dt{letter-spacing:.08em}
  .facts .v{margin-top:14px;font-size:36px}
  .facts .d{margin-top:10px;font-size:13px;line-height:20px}
  .prose h2{font-size:24px}
}
@media (prefers-reduced-motion:reduce){.ico i{animation:none}.btn,.btn-primary::after,.copy-text{transition:none}}
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <a class="brand" href="https://www.plivo.com/" aria-label="Plivo"><svg aria-hidden="true" fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 208 103"><g><path d="M75.83,78.5V16.92c0-.32-.26-.59-.59-.59h-12.27c-.32,0-.59.26-.59.59v61.57c0,.32.26.59.59.59h12.27c.32,0,.59-.26.59-.59h0ZM84.2,79.08h12.27c.32,0,.59-.26.59-.59v-42.76c0-.32-.26-.59-.59-.59h-12.27c-.32,0-.59.26-.59.59v42.76c0,.32.26.59.59.59ZM134.97,35.74l-8.86,25.04-8.85-25.24c-.08-.24-.3-.39-.55-.39h-13.57c-.42,0-.7.42-.54.81l17.25,42.76c.09.22.3.37.54.37h10.05c.23,0,.44-.14.54-.35l18.82-42.76c.17-.39-.11-.82-.54-.82h-13.65c-.25,0-.47.16-.55.39l-.09.19Z"/><path d="M130.44,79.6h-10.05c-.44,0-.84-.27-1.02-.69l-17.25-42.76c-.14-.34-.1-.73.1-1.03.2-.3.55-.49.91-.49h13.57c.47,0,.89.3,1.04.74l8.36,23.85,8.48-23.9c.13-.39.55-.68,1.02-.68h13.65c.38,0,.72.19.93.5.2.31.24.7.09,1.04l-18.82,42.76c-.19.41-.59.66-1.01.66ZM103.14,35.67h0s-.06.1-.06.1l17.25,42.76,10.11.05,18.89-42.8-.07-.1-13.66.03-.08.07-.08.17-9.34,26.39-9.33-26.62-13.63-.05ZM96.47,79.59h-12.27c-.61,0-1.11-.5-1.11-1.1v-42.76c0-.61.5-1.11,1.11-1.11h12.27c.61,0,1.1.5,1.1,1.11v42.76c0,.61-.5,1.1-1.1,1.1ZM84.2,35.65s-.08.03-.08.08v42.76s.03.08.08.08h12.27s.07-.03.07-.08v-42.76s-.03-.08-.07-.08h-12.27ZM75.24,79.59h-12.27c-.61,0-1.11-.5-1.11-1.1V16.92c0-.61.5-1.11,1.11-1.11h12.27c.61,0,1.1.5,1.1,1.11v61.58c0,.6-.5,1.09-1.1,1.09ZM62.97,16.84s-.08.03-.08.08v61.57s.03.08.08.08h12.27s.07-.03.07-.08V16.92s-.03-.08-.07-.08h-12.27Z"/></g><path d="M25.45,42.56c-1.52.59-3.06.98-4.39,1.98-2.03,1.53-2.82,3.63-3.58,5.97-.08.11-.29.11-.36,0-.57-1.52-.97-3.04-1.97-4.35-1.7-2.23-3.31-2.5-5.73-3.48-.19-.08-.41-.13-.25-.4.07-.12,2.21-.82,2.55-.97,2.09-.89,3.62-2.44,4.51-4.53.34-.81.56-1.69.92-2.48l.18-.06.19.16c.71,2.25,1.49,4.26,3.39,5.76,1.33,1.05,2.89,1.48,4.45,2.06.12.07.11.22.08.34h.01Z"/><path fill-rule="evenodd" d="M19.13,15.84l5.03,2.16h0l30.12,13.62s.1.05.14.08h0l.31.19c.35.29,1.05,1.14,1.01,2.2v15.48c-.02.66-.33,2.05-1.33,2.69-.04.04-.1.07-.15.09l-21.99,10.15v16.01c0,.57-.46,1.03-1.03,1.03h-12.44c-.57,0-1.03-.46-1.03-1.03v-23.91c0-.06,0-.12.01-.17.03-.37.32-1.23,1.21-1.75.03-.02.07-.04.11-.06l22.94-10.58-24.17-10.91c-.31-.14-.46-.47-.39-.78v-.51l.14-11.74c-.19-1.94.93-2.3,1.52-2.24v-.02Z"/><path d="M32.94,62.16c-.61.32-.71.83-.69,1.05l-.67-1.05c.71-.13,1.97-.32,1.36,0Z"/><ellipse cx="89.96" cy="23.39" rx="7.23" ry="7.53"/><path d="M174.36,33.5c-13.55,0-24.53,10.57-24.53,23.61s10.98,23.62,24.53,23.62,24.53-10.57,24.53-23.62-10.98-23.61-24.53-23.61ZM174.36,67.27c-5.28,0-9.56-4.55-9.56-10.16s4.28-10.16,9.56-10.16,9.56,4.55,9.56,10.16-4.28,10.16-9.56,10.16Z"/></svg><span>MCP server</span></a>
    <nav aria-label="Plivo links">
      <a href="https://www.plivo.com/docs">Docs</a>
      <a href="https://cx.plivo.com">Console</a>
    </nav>
    <button class="theme" type="button" id="theme" aria-label="Switch to dark mode"><svg class="sun" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="3.25"/><path d="M9 1.5v1.75M9 14.75v1.75M1.5 9h1.75M14.75 9h1.75M3.7 3.7l1.24 1.24M13.06 13.06l1.24 1.24M3.7 14.3l1.24-1.24M13.06 4.94l1.24-1.24"/></svg><svg class="moon" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 10.6A6.75 6.75 0 0 1 7.4 2.5a6.75 6.75 0 1 0 8.1 8.1Z"/></svg></button>
  </div>
</header>

<section class="hero">
  <div class="hero-in">
    <div class="hero-copy">
      <h1>Plivo MCP server</h1>
      <p class="lede">Connect Claude, Cursor or any MCP client to your Plivo account with one URL, then ask for what you need in plain words.</p>
      <div class="urlbox">
        <span class="urlbox-label">Server URL</span>
        <code>https://mcp.plivo.com/mcp</code>
        <button class="copy copy-text" type="button" aria-label="Copy the server URL"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.25 5.25H7.25C6.14543 5.25 5.25 6.14543 5.25 7.25V14.25C5.25 15.3546 6.14543 16.25 7.25 16.25H14.25C15.3546 16.25 16.25 15.3546 16.25 14.25V7.25C16.25 6.14543 15.3546 5.25 14.25 5.25Z"/><path d="M2.80103 11.998L1.77203 5.07397C1.61003 3.98097 2.36403 2.96397 3.45603 2.80197L10.38 1.77297C11.313 1.63397 12.19 2.16297 12.528 3.00097"/></svg><span class="c1">Copy</span><span class="c2">Copied</span></button>
      </div>
      <p class="hint">This address is for AI apps, not a browser. There is nothing to install.</p>
      <div class="cta">
        <a class="btn btn-primary" href="#connect">Connect your app</a>
        <a class="btn" href="#tools">See the tools</a>
      </div>
    </div>

    <figure class="demo" id="demo">
      <figcaption class="demo-alt">Example of a paid action: you ask your AI app to find a local number in San Francisco and buy it. It searches and finds 3 numbers, then stops and asks you to approve buying +1 415 555 0134 before anything is paid for.</figcaption>
      <div aria-hidden="true">
        <div class="demo-h"><span><i></i>plivo/mcp</span></div>
        <div class="demo-b">
          <p class="say"><span class="who">you &rsaquo;</span> <span class="typed">Find a local number in San Francisco and buy it.</span><span class="caret"></span><span class="rest"></span></p>
          <ul class="steps">
            <li class="is-done"><span class="ico"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 9.5l3.5 3.5 7-8"/></svg><i></i></span><code>search_numbers</code><span class="note">3 numbers found</span></li>
            <li class="is-wait"><span class="ico"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 9.5l3.5 3.5 7-8"/></svg><i></i></span><code>buy_number</code><span class="note">waiting for you</span></li>
          </ul>
          <div class="stage">
            <div class="approve">
              <p class="approve-t">Approve this action?</p>
              <p class="approve-d">Buy <strong>+1 415 555 0134</strong>. You see the price and the account that pays before you decide.</p>
              <div class="approve-b"><span class="pill pill-on">Approve</span><span class="pill">Deny</span></div>
            </div>
            <div class="ghost"><i></i><i></i><i></i><i></i><i></i></div>
            <p class="receipt off">Approved. <strong>+1 415 555 0134</strong> is bought only after you say yes.</p>
          </div>
        </div>
        <p class="demo-f">tool: buy_number &#9656; asks first</p>
        <svg class="ptr" viewBox="0 0 18 18" fill="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3 2l11 6.2-4.9 1.4L11.6 15l-2.2 1-2.4-5.3L3.6 14z"/></svg>
      </div>
    </figure>
  </div>

  <div class="facts">
    <dl>
      <div><dt>Operations</dt><dd class="v"><span data-to="130">130</span><b>+</b></dd><dd class="d">Plivo API operations your app can reach.</dd></div>
      <div><dt>Tools</dt><dd class="v"><span data-to="20">20</span></dd><dd class="d">Tools your app gets, shortcuts included.</dd></div>
      <div><dt>Sign-in lasts</dt><dd class="v"><span data-to="30">30</span><small>days</small></dd><dd class="d">One OAuth sign-in in your browser.</dd></div>
      <div><dt>API keys to paste</dt><dd class="v">0</dd><dd class="d">Nothing to copy, store or rotate.</dd></div>
    </dl>
  </div>
</section>

<div class="page">
  <main class="main" id="top">
    <div class="prose">
      <h2 id="connect">Connect</h2>
      <p>The same URL works in every app. We have tested Claude and Claude Code. The other apps should work, as should any MCP client that supports OAuth sign-in.</p>
<div class="tabs">
          <ul class="tablist" role="tablist" aria-label="AI app">
            <li role="presentation"><button role="tab" type="button" id="t-claude" aria-controls="p-claude" aria-selected="true">Claude</button></li>
            <li role="presentation"><button role="tab" type="button" id="t-cc" aria-controls="p-cc" aria-selected="false" tabindex="-1">Claude Code</button></li>
            <li role="presentation"><button role="tab" type="button" id="t-cursor" aria-controls="p-cursor" aria-selected="false" tabindex="-1">Cursor</button></li>
            <li role="presentation"><button role="tab" type="button" id="t-vscode" aria-controls="p-vscode" aria-selected="false" tabindex="-1">VS Code</button></li>
            <li role="presentation"><button role="tab" type="button" id="t-chatgpt" aria-controls="p-chatgpt" aria-selected="false" tabindex="-1">ChatGPT</button></li>
            <li role="presentation"><button role="tab" type="button" id="t-other" aria-controls="p-other" aria-selected="false" tabindex="-1">Other</button></li>
          </ul>

          <div class="panel" role="tabpanel" id="p-claude" aria-labelledby="t-claude">
            <p>Works on claude.ai and in the Claude desktop app.</p>
            <ol>
              <li>Open <strong>Settings</strong>, then <strong>Connectors</strong>.</li>
              <li>Choose <strong>Add custom connector</strong>.</li>
              <li>Name it <code>Plivo</code> and paste <code>https://mcp.plivo.com/mcp</code>.</li>
              <li>Choose <strong>Connect</strong>, sign in to Plivo and choose <strong>Allow</strong>.</li>
            </ol>
          </div>

          <div class="panel" role="tabpanel" id="p-cc" aria-labelledby="t-cc" hidden>
            <p>Run this in your terminal:</p>
            <div class="cb">
              <button class="copy" type="button" aria-label="Copy the command"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.25 5.25H7.25C6.14543 5.25 5.25 6.14543 5.25 7.25V14.25C5.25 15.3546 6.14543 16.25 7.25 16.25H14.25C15.3546 16.25 16.25 15.3546 16.25 14.25V7.25C16.25 6.14543 15.3546 5.25 14.25 5.25Z"/><path d="M2.80103 11.998L1.77203 5.07397C1.61003 3.98097 2.36403 2.96397 3.45603 2.80197L10.38 1.77297C11.313 1.63397 12.19 2.16297 12.528 3.00097"/></svg></button>
              <pre><code><span class="k">claude</span> <span class="s">mcp add --transport http plivo https://mcp.plivo.com/mcp</span></code></pre>
            </div>
            <p>Then start Claude Code, type <code>/mcp</code>, pick <code>plivo</code> and sign in.</p>
          </div>

          <div class="panel" role="tabpanel" id="p-cursor" aria-labelledby="t-cursor" hidden>
            <p>Add this to <code>~/.cursor/mcp.json</code>, or to <code>.cursor/mcp.json</code> in a project:</p>
            <div class="cb">
              <button class="copy" type="button" aria-label="Copy the configuration"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.25 5.25H7.25C6.14543 5.25 5.25 6.14543 5.25 7.25V14.25C5.25 15.3546 6.14543 16.25 7.25 16.25H14.25C15.3546 16.25 16.25 15.3546 16.25 14.25V7.25C16.25 6.14543 15.3546 5.25 14.25 5.25Z"/><path d="M2.80103 11.998L1.77203 5.07397C1.61003 3.98097 2.36403 2.96397 3.45603 2.80197L10.38 1.77297C11.313 1.63397 12.19 2.16297 12.528 3.00097"/></svg></button>
              <pre><code>{
  <span class="p">"mcpServers"</span>: {
    <span class="p">"plivo"</span>: {
      <span class="p">"url"</span>: <span class="s">"https://mcp.plivo.com/mcp"</span>
    }
  }
}</code></pre>
            </div>
            <p>Then open <strong>Settings</strong>, go to <strong>MCP</strong> and choose <strong>Connect</strong> next to <code>plivo</code>.</p>
            <div class="callout" role="note"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="7.25"/><path d="M9 12.75V8.5"/><path d="M9 5.75h.01" stroke-width="2"/></svg><p>We have not tested Cursor yet. It should work like any MCP client that supports OAuth.</p></div>
          </div>

          <div class="panel" role="tabpanel" id="p-vscode" aria-labelledby="t-vscode" hidden>
            <p>Add this to <code>.vscode/mcp.json</code> in your workspace:</p>
            <div class="cb">
              <button class="copy" type="button" aria-label="Copy the configuration"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.25 5.25H7.25C6.14543 5.25 5.25 6.14543 5.25 7.25V14.25C5.25 15.3546 6.14543 16.25 7.25 16.25H14.25C15.3546 16.25 16.25 15.3546 16.25 14.25V7.25C16.25 6.14543 15.3546 5.25 14.25 5.25Z"/><path d="M2.80103 11.998L1.77203 5.07397C1.61003 3.98097 2.36403 2.96397 3.45603 2.80197L10.38 1.77297C11.313 1.63397 12.19 2.16297 12.528 3.00097"/></svg></button>
              <pre><code>{
  <span class="p">"servers"</span>: {
    <span class="p">"plivo"</span>: {
      <span class="p">"type"</span>: <span class="s">"http"</span>,
      <span class="p">"url"</span>: <span class="s">"https://mcp.plivo.com/mcp"</span>
    }
  }
}</code></pre>
            </div>
            <p>Then choose <strong>Start</strong> above the server entry and sign in.</p>
            <div class="callout" role="note"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="7.25"/><path d="M9 12.75V8.5"/><path d="M9 5.75h.01" stroke-width="2"/></svg><p>We have not tested VS Code yet. It should work like any MCP client that supports OAuth.</p></div>
          </div>

          <div class="panel" role="tabpanel" id="p-chatgpt" aria-labelledby="t-chatgpt" hidden>
            <ol>
              <li>Open <strong>Settings</strong>, then <strong>Apps &amp; Connectors</strong>, then <strong>Advanced settings</strong>, and turn on <strong>Developer mode</strong>.</li>
              <li>Create a connector and paste <code>https://mcp.plivo.com/mcp</code>.</li>
              <li>Choose <strong>OAuth</strong> for authentication, then sign in to Plivo.</li>
            </ol>
            <div class="callout" role="note"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="7.25"/><path d="M9 12.75V8.5"/><path d="M9 5.75h.01" stroke-width="2"/></svg><p>We have not tested ChatGPT yet. It should work like any MCP client that supports OAuth.</p></div>
          </div>

          <div class="panel" role="tabpanel" id="p-other" aria-labelledby="t-other" hidden>
            <p>Any app that supports remote MCP servers over HTTP with OAuth sign-in can use the same URL. Add <code>https://mcp.plivo.com/mcp</code> as a remote or HTTP server, with no API key. The app opens the Plivo sign-in page for you.</p>
          </div>
        </div>

      <h2 id="sign-in">Sign in</h2>
      <p>The first time you connect, the app opens a Plivo page. You sign in as usual, then see a screen that names the app asking for access.</p>
      <ul>
        <li><strong>Check the app.</strong> The screen shows the address the access goes to, then the app's name. Choose <strong>Allow</strong> only if you started this.</li>
        <li><strong>Pick the organizations.</strong> If your user belongs to more than one, tick the ones this connection may use on the same screen. It starts on the organization you signed in to. To move to another one you ticked, ask your app to switch organization. It asks you first.</li>
        <li><strong>Access lasts 30 days.</strong> After that the app asks you to sign in again.</li>
        <li><strong>Your Auth Token stays with Plivo.</strong> The app gets its own limited access, shown in the console as <strong>Plivo MCP</strong>.</li>
      </ul>

      <h2 id="what-you-can-do">What you can do</h2>
      <p>The server reaches 130+ Plivo API operations. Ask in plain words, and your app finds the right one and calls it.</p>
      <div class="tw"><table class="stack">
        <thead><tr><th>Product</th><th>Try asking</th></tr></thead>
        <tbody>
          <tr><td>Messaging</td><td class="ex">"Send an SMS to +1 415 555 0134 saying the order has shipped."</td></tr>
          <tr><td>Voice</td><td class="ex">"List the calls I got yesterday."</td></tr>
          <tr><td>Phone numbers</td><td class="ex">"Find a local number in San Francisco and buy it."</td></tr>
          <tr><td>SIP trunking</td><td class="ex">"Create a SIP trunk for my office PBX."</td></tr>
          <tr><td>AI agents</td><td class="ex">"Show my AI agents and pause the support agent."</td></tr>
          <tr><td>Verify</td><td class="ex">"Send a verification code to +1 415 555 0134."</td></tr>
          <tr><td>Account</td><td class="ex">"What is my account balance?"</td></tr>
          <tr><td>Docs search</td><td class="ex">"How do I record a call with Plivo XML?"</td></tr>
        </tbody>
      </table></div>
      <p>It also covers Audio Streaming, number masking, 10DLC and toll-free verification.</p>

      <h2 id="tools">Tools</h2>
      <p>Your app gets 20 tools: four universal tools that reach every operation, <code>search_docs</code>, 13 shortcuts that do the common tasks in one step, and two diagnose tools.</p>

      <h3 id="universal-tools">Universal tools</h3>
      <div class="tw"><table class="stack">
        <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>plivo_api_search</code></td><td>Finds an operation from what you want to do.</td></tr>
          <tr><td><code>plivo_api_details</code></td><td>Shows an operation's parameters and whether it asks first.</td></tr>
          <tr><td><code>plivo_api_read</code></td><td>Reads: messages, calls, numbers, recordings, agents and more.</td></tr>
          <tr><td><code>plivo_api_write</code></td><td>Changes things: send, buy, create, update, delete.</td></tr>
          <tr><td><code>search_docs</code></td><td>Searches Plivo's guides and API reference.</td></tr>
        </tbody>
      </table></div>

      <h3 id="shortcuts">Shortcuts</h3>
      <div class="tw"><table class="stack">
        <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>get_account</code></td><td>Shows your account details and balance.</td></tr>
          <tr><td><code>list_numbers</code></td><td>Lists the phone numbers on your account.</td></tr>
          <tr><td><code>search_numbers</code></td><td>Searches numbers available to buy in a country.</td></tr>
          <tr><td><code>buy_number</code></td><td>Buys a number. Asks first.</td></tr>
          <tr><td><code>list_messages</code></td><td>Lists sent and received messages.</td></tr>
          <tr><td><code>get_message</code></td><td>Shows one message.</td></tr>
          <tr><td><code>send_sms</code></td><td>Sends an SMS, MMS or WhatsApp message. Asks first.</td></tr>
          <tr><td><code>list_calls</code></td><td>Lists completed calls.</td></tr>
          <tr><td><code>get_call</code></td><td>Shows the record of one call.</td></tr>
          <tr><td><code>make_call</code></td><td>Starts an outbound call. Asks first.</td></tr>
          <tr><td><code>hangup_call</code></td><td>Hangs up a live call. Asks first.</td></tr>
          <tr><td><code>list_organizations</code></td><td>Lists the organizations this connection can use and which one is current.</td></tr>
          <tr><td><code>switch_organization</code></td><td>Moves the connection to another of those organizations. Asks first.</td></tr>
        </tbody>
      </table></div>
      <p>A switch applies to the whole connection, so every chat in that app moves with it. An approval given before a switch does not carry over.</p>

      <h3 id="diagnose-tools">Diagnose</h3>
      <div class="tw"><table class="stack">
        <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>diagnose_call</code></td><td>Asks Plivo's support assistant what happened on a call. Takes up to 2 minutes.</td></tr>
          <tr><td><code>diagnose_message</code></td><td>Asks Plivo's support assistant why a message failed or what its status means.</td></tr>
        </tbody>
      </table></div>

      <h2 id="approvals">Approvals</h2>
      <p>Reads run without asking, apart from two paid number lookups. Before a change that matters, the server stops and asks for your approval. It asks when an action:</p>
      <ul>
        <li><strong>costs money</strong>, such as sending a message, making a call or buying a number;</li>
        <li><strong>cannot be undone</strong>, such as releasing a number or deleting a recording;</li>
        <li><strong>keeps working after you disconnect</strong>, such as a new SIP endpoint or trunk credential;</li>
        <li><strong>changes where calls and messages go</strong>, such as an application or number setting;</li>
        <li><strong>acts on a live call</strong>, such as transferring it or pressing keypad digits;</li>
        <li><strong>creates or changes an AI agent</strong>, such as publishing or pausing it;</li>
        <li><strong>changes the account's own details</strong>, such as its name or address;</li>
        <li><strong>files or changes a registration that carriers or regulators review</strong>, such as 10DLC or toll-free verification.</li>
      </ul>
      <p>The approval shows the whole action: every field, the organization (account) it will run on and, when it costs money, the balance. For a number it also shows the monthly and setup price. Taxes may apply.</p>
      <p>In an app that shows an approval dialog, such as Claude Code, you pick <strong>Approve</strong> or <strong>Deny</strong> in the app. Nothing is selected for you. In an app without one, such as Claude or ChatGPT, the tool returns a link to a Plivo Console page. Open it, sign in to the Console and approve or deny there. Only an admin of that organization can approve. Anyone else is told to ask an admin.</p>
      <div class="callout warn" role="note">
        <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M 9 6.75 v 1.5 m 0 3 h 0.0075 m -5.2035 3 h 10.392 c 1.155 0 1.8765 -1.2503 1.299 -2.25 L 10.299 3 c -0.5775 -0.9997 -2.0205 -0.9997 -2.598 0 L 2.505 12 c -0.5775 0.9997 0.144 2.25 1.299 2.25 z"/></svg>
        <p>Read the action before you approve it. An approval covers that exact request, works once and expires after 5 minutes. A message or call to more than 10 recipients is refused.</p>
      </div>

      <h2 id="security">Security</h2>
      <ul>
        <li><strong>Limited access.</strong> The app gets its own token, never your Auth Token. It can use the operations above and nothing else.</li>
        <li><strong>Access expires.</strong> The token stops working after 30 days.</li>
        <li><strong>You can remove access.</strong> Disconnect the server in your AI app. In Claude Code, for example, run <code>/mcp</code>, pick Plivo and choose <strong>Clear authentication</strong>, and the access ends straight away. Some apps only forget the connection on their side; the access then ends by itself after 30 days. If your <a href="https://cx.plivo.com">console</a> shows a <strong>Plivo MCP</strong> entry under API keys, deleting it also ends the access at once.</li>
        <li><strong>Sub-accounts are limited.</strong> The app cannot create, manage or act as a sub-account. <code>buy_number</code> can assign a number to one, and <code>list_numbers</code> and <code>list_messages</code> can filter by one.</li>
        <li><strong>Secrets stay hidden.</strong> Passwords, tokens and keys are hidden in approval previews.</li>
        <li><strong>Checked before sending.</strong> The server refuses values that cannot be phone numbers and callback URLs that are not public <code>https</code> addresses.</li>
      </ul>

      <h2 id="troubleshooting">Troubleshooting</h2>
      <div class="tw"><table class="stack">
        <thead><tr><th>What you see</th><th>What to do</th></tr></thead>
        <tbody>
          <tr><td>The app asks you to sign in again</td><td>Your access expired after 30 days or was removed. Sign in and choose Allow again.</td></tr>
          <tr><td>The app asks you to sign in again before 30 days are up</td><td>A tool needs access that was added after you signed in, such as AI agents. Sign in and choose Allow again.</td></tr>
          <tr><td>A tool is not listed</td><td>Restart the app or reconnect the server.</td></tr>
          <tr><td><code>list_calls</code> misses older calls</td><td>With no end time it searches only the last 7 days. Ask for a date range of up to 30 days within the last 90.</td></tr>
        </tbody>
      </table></div>
    </div>

    <footer class="foot">
      <span>&copy; Plivo</span>
      <a href="https://www.plivo.com/docs">Docs</a>
      <a href="https://cx.plivo.com">Console</a>
    </footer>
  </main>

  <aside class="toc" aria-label="On this page">
    <p>On this page</p>
    <ul id="toclinks">
      <li><a href="#connect">Connect</a></li>
      <li><a href="#sign-in">Sign in</a></li>
      <li><a href="#what-you-can-do">What you can do</a></li>
      <li><a href="#tools">Tools</a></li>
      <li><a href="#approvals">Approvals</a></li>
      <li><a href="#security">Security</a></li>
      <li><a href="#troubleshooting">Troubleshooting</a></li>
    </ul>
  </aside>
</div>
<script>
(function(){
  var $=function(s,r){return [].slice.call((r||document).querySelectorAll(s))};
  $('[role=tablist]').forEach(function(list){
    var tabs=$('[role=tab]',list);
    function pick(t,focus){tabs.forEach(function(x){var on=x===t;x.setAttribute('aria-selected',on);x.tabIndex=on?0:-1;document.getElementById(x.getAttribute('aria-controls')).hidden=!on});if(focus)t.focus()}
    tabs.forEach(function(t,i){
      t.addEventListener('click',function(){pick(t)});
      t.addEventListener('keydown',function(e){var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(d){e.preventDefault();pick(tabs[(i+d+tabs.length)%tabs.length],true)}});
    });
  });
  $('.copy').forEach(function(b){
    var label=b.getAttribute('aria-label');
    b.addEventListener('click',function(){
      var text=b.parentNode.querySelector('code').textContent;
      function done(){b.classList.add('ok');b.setAttribute('aria-label','Copied');setTimeout(function(){b.classList.remove('ok');b.setAttribute('aria-label',label)},1600)}
      function old(){var t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();try{document.execCommand('copy');done()}catch(e){}document.body.removeChild(t)}
      if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(done,old);else old();
    });
  });
  var tb=document.getElementById('theme'),root=document.documentElement,mq=window.matchMedia('(prefers-color-scheme: dark)');
  function isDark(){var a=root.getAttribute('data-theme');return a?a==='dark':mq.matches}
  function label(){tb.setAttribute('aria-label',isDark()?'Switch to light mode':'Switch to dark mode')}
  tb.addEventListener('click',function(){var n=isDark()?'light':'dark';root.setAttribute('data-theme',n);try{localStorage.setItem('theme',n)}catch(e){}label()});
  if(mq.addEventListener)mq.addEventListener('change',label);label();
  var heads=$('.prose h2'),toc=$('#toclinks a');
  function spy(){
    var cur='',y=window.scrollY+120;
    heads.forEach(function(h){if(h.getBoundingClientRect().top+window.scrollY<=y)cur=h.id});
    if(window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-4)cur=heads[heads.length-1].id;
    toc.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+cur)});
  }
  window.addEventListener('scroll',spy,{passive:true});spy();
  (function(){
    var d=document.getElementById('demo');if(!d||!d.classList)return;
    var rm=window.matchMedia('(prefers-reduced-motion: reduce)');
    var q=function(c){return d.querySelector(c)},body=q('.demo-b'),typed=q('.typed'),rest=q('.rest'),rows=$('.steps li',d),notes=$('.note',d),box=q('.approve'),rec=q('.receipt'),ok=q('.pill-on'),ptr=q('.ptr');
    var text=typed.textContent,timer=0,i=0,last=0,seen=!('IntersectionObserver' in window),going=false;
    function row(n,state,note){rows[n].className=state;if(note)notes[n].textContent=note}
    function type(n){typed.textContent=text.slice(0,n);rest.textContent=text.slice(n)}
    function aim(dx,dy){var a=d.getBoundingClientRect(),b=ok.getBoundingClientRect();ptr.style.transform='translate('+(b.left-a.left+b.width/2+dx)+'px,'+(b.top-a.top+b.height/2+dy)+'px)'}
    function still(){d.classList.remove('live','held','typing');body.classList.remove('out');type(text.length);row(0,'is-done','3 numbers found');row(1,'is-wait','waiting for you');box.className='approve';rec.className='receipt off';ok.classList.remove('press');ptr.classList.remove('on')}
    var steps=[[450,function(){d.classList.add('typing');type(0);row(0,'off');row(1,'off');box.className='approve off';rec.className='receipt off';aim(110,70)}],[350,function(){body.classList.remove('out')}],[500,function(){type(1)}]];
    for(var n=2;n<=text.length;n++)steps.push([36,(function(n){return function(){type(n)}})(n)]);
    steps.push(
      [550,function(){d.classList.remove('typing');row(0,'is-run','searching')}],
      [1300,function(){row(0,'is-done','3 numbers found')}],
      [650,function(){row(1,'is-wait','waiting for you')}],
      [350,function(){box.className='approve'}],
      [1500,function(){ptr.classList.add('on');aim(2,4)}],
      [900,function(){ok.classList.add('press')}],
      [240,function(){ok.classList.remove('press')}],
      [260,function(){box.className='approve off gone';ptr.classList.remove('on');row(1,'is-run','buying')}],
      [900,function(){row(1,'is-done','number bought');rec.className='receipt'}],
      [2000,function(){body.classList.add('out')}]
    );
    last=i=steps.length-1;
    function next(){timer=setTimeout(function(){steps[i][1]();i=(i+1)%steps.length;next()},steps[i][0])}
    function sync(){
      var want=seen&&!document.hidden&&!rm.matches;
      if(rm.matches){clearTimeout(timer);going=false;i=last;still();return}
      if(want&&!going){going=true;d.classList.add('live');d.classList.remove('held');next()}
      else if(!want&&going){going=false;clearTimeout(timer);d.classList.add('held')}
    }
    if('IntersectionObserver' in window)new IntersectionObserver(function(e){seen=e[e.length-1].isIntersecting;sync()},{threshold:.25}).observe(d);
    document.addEventListener('visibilitychange',sync);
    if(rm.addEventListener)rm.addEventListener('change',sync);
    sync();
  })();
  (function(){
    var band=document.querySelector('.facts dl'),nums=$('[data-to]',band);
    if(!('IntersectionObserver' in window)||!window.requestAnimationFrame||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    var io=new IntersectionObserver(function(e){
      if(!e[e.length-1].isIntersecting)return;
      io.disconnect();var t0=0;
      (function tick(now){t0=t0||now;var k=Math.min(1,(now-t0)/1100),ease=1-Math.pow(1-k,3);nums.forEach(function(n){n.textContent=Math.round(+n.getAttribute('data-to')*ease)});if(k<1)requestAnimationFrame(tick)})(performance.now());
    },{threshold:.4});
    io.observe(band);
  })();
})();
</script>
</body>
</html>
`;

const blocks = (tag: string) => [...HTML.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);

async function sources(tag: string): Promise<string> {
  const hashes = await Promise.all(
    blocks(tag).map(async (text) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
    }),
  );
  return hashes.join(" ");
}

let policy: Promise<string> | undefined;

// Hashed from the page itself on first use, so an edit to the page cannot leave a stale hash behind.
function pagePolicy(): Promise<string> {
  policy ??= Promise.all([sources("style"), sources("script")]).then(
    ([style, script]) =>
      `default-src 'none'; style-src ${style} https://fonts.googleapis.com; font-src https://fonts.gstatic.com; ` +
      `script-src ${script}; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  return policy;
}

const served = new WeakSet<Response>();

/** MCP clients and scripts do not ask for HTML; a person's browser does. */
export function wantsLandingPage(request: Request): boolean {
  return (request.method === "GET" || request.method === "HEAD") && (request.headers.get("Accept") ?? "").includes("text/html");
}

export function landingPage(request: Request): Response {
  const res = new Response(request.method === "HEAD" ? null : HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", Vary: "Accept" },
  });
  served.add(res);
  return res;
}

/** The page's own policy for a response landingPage() made; undefined for every other response. */
export function landingPolicy(res: Response): Promise<string> | undefined {
  return served.has(res) ? pagePolicy() : undefined;
}
