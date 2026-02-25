'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── COOKIE JAR ──────────────────────────────────────────────────────────────
const cookieJar = new Map();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// ─── SELF PING (keeps Railway alive) ─────────────────────────────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

setInterval(async () => {
  try { await axios.get(SELF_URL + '/ping', { timeout: 5000 }); }
  catch {}
}, 4 * 60 * 1000);

// ─── URL ENCODING (XOR obfuscation like real proxies use) ────────────────────
const XOR_KEY = 'butterproxy';

function xorEncode(str) {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  }
  return Buffer.from(result, 'binary').toString('base64url');
}

function xorDecode(encoded) {
  const str = Buffer.from(encoded, 'base64url').toString('binary');
  let result = '';
  for (let i = 0; i < str.length; i++) {
    result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  }
  return result;
}

function encodeProxyUrl(url) {
  return '/fetch?__bpx=' + xorEncode(url);
}

// ─── URL HELPERS ─────────────────────────────────────────────────────────────
function toAbs(rel, base) {
  try { return new URL(rel, base).href; } catch { return null; }
}

function shouldProxy(url) {
  if (!url) return false;
  if (url.startsWith('data:')) return false;
  if (url.startsWith('javascript:')) return false;
  if (url.startsWith('mailto:')) return false;
  if (url.startsWith('tel:')) return false;
  if (url.startsWith('blob:')) return false;
  if (url.startsWith('#')) return false;
  if (url.startsWith('/fetch?')) return false;
  return true;
}

function makeProxyUrl(rel, base) {
  const abs = toAbs(rel, base);
  if (!abs) return rel;
  return encodeProxyUrl(abs);
}

// ─── CSS REWRITER ─────────────────────────────────────────────────────────────
function rewriteCSS(css, baseUrl) {
  // Rewrite url() references
  css = css.replace(/url\(\s*(['"]?)([^'"\)\s]+)\1\s*\)/gi, (m, q, u) => {
    if (!shouldProxy(u)) return m;
    const abs = toAbs(u, baseUrl);
    if (!abs) return m;
    return `url(${q}${encodeProxyUrl(abs)}${q})`;
  });

  // Rewrite @import
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    if (!shouldProxy(u)) return m;
    const abs = toAbs(u, baseUrl);
    if (!abs) return m;
    return `@import ${q}${encodeProxyUrl(abs)}${q}`;
  });

  return css;
}

// ─── JAVASCRIPT REWRITER ──────────────────────────────────────────────────────
function rewriteJS(js, baseUrl) {
  const origin = new URL(baseUrl).origin;

  // Rewrite absolute URL strings in JS (fetch calls, XHR, etc.)
  // This catches patterns like fetch('https://...') and similar
  js = js.replace(
    /(['"`])(https?:\/\/[^'"`\s]+)\1/g,
    (match, quote, url) => {
      if (!shouldProxy(url)) return match;
      try {
        new URL(url); // validate
        return `${quote}${encodeProxyUrl(url)}${quote}`;
      } catch {
        return match;
      }
    }
  );

  // Rewrite window.location assignments
  js = js.replace(/window\.location\s*=\s*(['"`])([^'"`]+)\1/g, (m, q, u) => {
    const abs = toAbs(u, baseUrl);
    if (!abs || !shouldProxy(abs)) return m;
    return `window.location=${q}${encodeProxyUrl(abs)}${q}`;
  });

  // Rewrite location.href assignments
  js = js.replace(/location\.href\s*=\s*(['"`])([^'"`]+)\1/g, (m, q, u) => {
    const abs = toAbs(u, baseUrl);
    if (!abs || !shouldProxy(abs)) return m;
    return `location.href=${q}${encodeProxyUrl(abs)}${q}`;
  });

  return js;
}

// ─── HTML REWRITER ────────────────────────────────────────────────────────────
function rewriteHTML(html, baseUrl) {
  // Strip ALL security meta tags
  html = html.replace(/<meta[^>]*content-security-policy[^>]*>/gi, '');
  html = html.replace(/<meta[^>]*x-frame-options[^>]*>/gi, '');
  html = html.replace(/<meta[^>]*referrer[^>]*>/gi, '');

  // Rewrite standard attributes
  html = html.replace(
    /\b(src|href|action|poster|data-src|data-href|data-url|data-lazy|data-original)\s*=\s*(["'])([^"']*)\2/gi,
    (match, attr, quote, val) => {
      val = val.trim();
      if (!shouldProxy(val)) return match;
      const abs = toAbs(val, baseUrl);
      if (!abs) return match;
      return `${attr}=${quote}${encodeProxyUrl(abs)}${quote}`;
    }
  );

  // Rewrite srcset
  html = html.replace(/\bsrcset\s*=\s*(["'])([^"']*)\1/gi, (match, quote, srcset) => {
    const rewritten = srcset.split(',').map(part => {
      const trimmed = part.trim();
      const spaceIdx = trimmed.search(/\s/);
      const u = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
      if (!shouldProxy(u)) return part;
      const abs = toAbs(u, baseUrl);
      if (!abs) return part;
      return encodeProxyUrl(abs) + rest;
    }).join(', ');
    return `srcset=${quote}${rewritten}${quote}`;
  });

  // Rewrite inline styles
  html = html.replace(/\bstyle\s*=\s*(["'])([^"']*)\1/gi, (match, quote, style) => {
    return `style=${quote}${rewriteCSS(style, baseUrl)}${quote}`;
  });

  // Rewrite <style> blocks
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
    return open + rewriteCSS(css, baseUrl) + close;
  });

  // Rewrite inline <script> blocks (carefully)
  html = html.replace(/(<script(?![^>]*src)[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, js, close) => {
    if (open.includes('type') && !open.includes('javascript') && !open.includes('module')) return m;
    try {
      return open + rewriteJS(js, baseUrl) + close;
    } catch {
      return m;
    }
  });

  // Inject our master interception script
  const encodedBase = JSON.stringify(baseUrl);
  const script = `
<script>
(function(){
  'use strict';
  var BASE=${encodedBase};
  var XOR_KEY='butterproxy';

  // XOR encode/decode matching server
  function xorEncode(str){
    var result='';
    for(var i=0;i<str.length;i++){
      result+=String.fromCharCode(str.charCodeAt(i)^XOR_KEY.charCodeAt(i%XOR_KEY.length));
    }
    return btoa(result).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
  }

  function toAbs(u){
    if(!u)return u;
    try{return new URL(u,BASE).href;}catch(e){return u;}
  }

  function shouldProxy(u){
    if(!u)return false;
    var bad=['data:','javascript:','mailto:','tel:','blob:','#','/fetch?'];
    for(var i=0;i<bad.length;i++){if(u.startsWith(bad[i]))return false;}
    return true;
  }

  function px(u){
    var abs=toAbs(u);
    if(!abs||!shouldProxy(abs))return u;
    return '/fetch?__bpx='+xorEncode(abs);
  }

  // ── Patch fetch ──
  var _fetch=window.fetch;
  window.fetch=function(resource,init){
    if(typeof resource==='string'&&shouldProxy(resource)){
      resource=px(resource);
    } else if(resource&&resource.url&&shouldProxy(resource.url)){
      resource=new Request(px(resource.url),resource);
    }
    return _fetch.call(this,resource,init);
  };

  // ── Patch XHR ──
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    if(typeof url==='string'&&shouldProxy(url))url=px(url);
    var args=Array.prototype.slice.call(arguments);
    args[1]=url;
    return _open.apply(this,args);
  };

  // ── Patch WebSocket (intercept but can't truly proxy) ──
  var _WS=window.WebSocket;
  window.WebSocket=function(url,protocols){
    console.warn('[Butter] WebSocket blocked:',url);
    // Return a dummy that silently fails
    return {
      send:function(){},
      close:function(){},
      addEventListener:function(){},
      removeEventListener:function(){}
    };
  };

  // ── Patch Image src ──
  var _imgDesc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  if(_imgDesc){
    Object.defineProperty(HTMLImageElement.prototype,'src',{
      set:function(v){
        _imgDesc.set.call(this,shouldProxy(v)?px(v):v);
      },
      get:function(){return _imgDesc.get.call(this);}
    });
  }

  // ── Patch history ──
  var _push=history.pushState,_replace=history.replaceState;
  history.pushState=function(s,t,u){
    if(u)window.parent.postMessage({type:'bb-url',url:toAbs(u)},'*');
    return _push.apply(this,arguments);
  };
  history.replaceState=function(s,t,u){
    if(u)window.parent.postMessage({type:'bb-url',url:toAbs(u)},'*');
    return _replace.apply(this,arguments);
  };

  // ── Intercept link clicks ──
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');
    if(!a)return;
    var h=a.getAttribute('href');
    if(!h||!shouldProxy(h))return;
    e.preventDefault();e.stopPropagation();
    window.parent.postMessage({type:'bb-navigate',url:toAbs(h)},'*');
  },true);

  // ── Intercept form submit ──
  document.addEventListener('submit',function(e){
    var f=e.target;
    var action=f.getAttribute('action')||BASE;
    if(!shouldProxy(action))return;
    e.preventDefault();
    var absAction=toAbs(action);
    var method=(f.method||'get').toUpperCase();
    var params=new URLSearchParams(new FormData(f)).toString();
    var finalUrl=method==='POST'?absAction:absAction+(absAction.includes('?')?'&':'?')+params;
    window.parent.postMessage({type:'bb-navigate',url:finalUrl,method:method,body:method==='POST'?params:null},'*');
  },true);

  // ── Intercept dynamic script injection ──
  var _createElement=document.createElement.bind(document);
  document.createElement=function(tag){
    var el=_createElement(tag);
    if(tag.toLowerCase()==='script'){
      var _srcDesc=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src');
      if(_srcDesc){
        Object.defineProperty(el,'src',{
          set:function(v){
            _srcDesc.set.call(this,shouldProxy(v)?px(v):v);
          },
          get:function(){return _srcDesc.get.call(this);}
        });
      }
    }
    return el;
  };

  // ── Report URL to parent ──
  window.parent.postMessage({type:'bb-url',url:BASE},'*');

  // ── Override document.domain ──
  try{Object.defineProperty(document,'domain',{get:function(){return new URL(BASE).hostname;},set:function(){}});}catch(e){}

})();
</script>`;

  if (html.includes('</head>')) {
    html = html.replace('</head>', script + '</head>');
  } else if (html.match(/<body[^>]*>/i)) {
    html = html.replace(/<body[^>]*>/i, m => m + script);
  } else {
    html = script + html;
  }

  return html;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/ping', (req, res) => res.send('🧈'));

app.get('/', (req, res) => {
  res.send(`<html><body style="background:#1a1200;color:#f5c842;font-family:sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100vh;gap:12px;text-align:center;padding:20px;">
    <div style="font-size:64px">🧈</div>
    <h1>Butter Proxy v3</h1>
    <p style="color:#c8a040">Running! Use /fetch?__bpx=ENCODED_URL</p>
  </body></html>`);
});

// ─── MAIN PROXY ───────────────────────────────────────────────────────────────
app.all('/fetch', async (req, res) => {
  // Decode the XOR-encoded URL
  let targetUrl;
  if (req.query.__bpx) {
    try { targetUrl = xorDecode(req.query.__bpx); }
    catch { return res.status(400).send('Bad encoded URL'); }
  } else if (req.query.url) {
    // fallback for plain ?url= (backward compat)
    targetUrl = req.query.url;
  } else {
    return res.status(400).send('Missing url');
  }

  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { return res.status(400).send('Invalid URL'); }

  // Cookie jar per IP+domain
  const key = (req.ip || 'x') + '::' + parsed.hostname;
  if (!cookieJar.has(key)) cookieJar.set(key, {});
  const jar = cookieJar.get(key);
  const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  const isPost = req.method === 'POST';

  // Pick a realistic User-Agent (rotate between a few)
  const agents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  const ua = agents[Math.floor(Math.random() * agents.length)];

  try {
    const response = await axios({
      method: isPost ? 'POST' : 'GET',
      url: targetUrl,
      data: isPost ? req.body : undefined,
      responseType: 'arraybuffer',
      maxRedirects: 10,
      timeout: 25000,
      decompress: false,
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': parsed.origin + '/',
        'Origin': parsed.origin,
        'sec-ch-ua': '"Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'Upgrade-Insecure-Requests': '1',
        ...(cookieStr ? { Cookie: cookieStr } : {}),
      },
      validateStatus: () => true,
    });

    // Save cookies
    const setCookies = response.headers['set-cookie'];
    if (setCookies) {
      (Array.isArray(setCookies) ? setCookies : [setCookies]).forEach(c => {
        const [pair] = c.split(';');
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) return;
        const name = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        jar[name] = value;
      });
    }

    // Strip all security / blocking headers
    const strip = new Set([
      'x-frame-options', 'content-security-policy',
      'content-security-policy-report-only', 'x-content-type-options',
      'strict-transport-security', 'set-cookie', 'transfer-encoding',
      'content-encoding', 'content-length', 'x-xss-protection',
      'expect-ct', 'report-to', 'nel', 'permissions-policy',
    ]);

    Object.keys(response.headers).forEach(h => {
      if (!strip.has(h.toLowerCase())) {
        try { res.setHeader(h, response.headers[h]); } catch {}
      }
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('X-Frame-Options', 'ALLOWALL');

    const ct = (response.headers['content-type'] || '').toLowerCase();
    const enc = (response.headers['content-encoding'] || '').toLowerCase();

    // Decompress
    let buf = response.data;
    try {
      if (enc.includes('br'))           buf = zlib.brotliDecompressSync(buf);
      else if (enc.includes('gzip'))    buf = zlib.gunzipSync(buf);
      else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
    } catch { /* use raw */ }

    res.setHeader('Content-Type', ct || 'application/octet-stream');

    if (ct.includes('text/html')) {
      return res.send(rewriteHTML(buf.toString('utf-8'), targetUrl));
    }
    if (ct.includes('text/css')) {
      return res.send(rewriteCSS(buf.toString('utf-8'), targetUrl));
    }
    if (ct.includes('javascript') || ct.includes('ecmascript')) {
      try {
        return res.send(rewriteJS(buf.toString('utf-8'), targetUrl));
      } catch {
        return res.send(buf);
      }
    }

    // Everything else — stream raw
    return res.send(buf);

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(500).send(`
      <html><body style="background:#1a1200;color:#f5c842;font-family:sans-serif;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        height:100vh;gap:16px;text-align:center;padding:20px;">
        <div style="font-size:60px">🧈</div>
        <h2>Couldn't load this page</h2>
        <p style="color:#c8a040;max-width:300px;line-height:1.6">
          This site may block proxies or use advanced protection. Try something else!
        </p>
        <p style="color:#555;font-size:12px">${err.message}</p>
      </body></html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`🧈 Butter Proxy v3 on port ${PORT}`);
  console.log(`🧈 Self-ping: ${SELF_URL}/ping every 4 min`);
});
