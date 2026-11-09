import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const DEFAULT_MODEL = 'grok-4.20-0309-non-reasoning';

class El {
  constructor(id, toastLog, byId) {
    this.id = id || '';
    this._toastLog = toastLog;
    this._byId = byId;
    this._html = '';
    this._tc = '';
    this.value = '';
    this.style = {};
    this._classes = new Set();
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      toggle: (c) => { this._classes.has(c) ? this._classes.delete(c) : this._classes.add(c); },
      contains: (c) => this._classes.has(c)
    };
  }
  set innerHTML(v) {
    this._html = String(v);
    const re = /<[^>]*\bid="([^"]+)"[^>]*>/gi;
    let m;
    while ((m = re.exec(this._html))) {
      if (m[1] === 'app') continue;
      const el = new El(m[1], this._toastLog, this._byId);
      const cls = /class="([^"]*)"/.exec(m[0]);
      if (cls) cls[1].split(/\s+/).filter(Boolean).forEach((c) => el._classes.add(c));
      this._byId.set(m[1], el);
    }
  }
  get innerHTML() { return this._html; }
  set textContent(v) {
    this._tc = v == null ? '' : String(v);
    if (this.id === 'toast' && this._tc) this._toastLog.push(this._tc);
  }
  get textContent() { return this._tc; }
  insertAdjacentHTML() {}
}

function boot(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const localStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const toastLog = [];
  const byId = new Map();
  const app = new El('app', toastLog, byId);
  byId.set('app', app);
  const document = {
    querySelector: (sel) => {
      const m = /^#([\w:-]+)$/.exec(sel || '');
      return m ? (byId.get(m[1]) || null) : null;
    },
    querySelectorAll: () => [],
    createElement: () => new El('', toastLog, byId),
    body: { appendChild(el) { if (el && el.id) byId.set(el.id, el); } }
  };
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    localStorage,
    document,
    fetch: async () => { throw new Error('fetch not stubbed'); },
    alert() {},
    confirm() { return true; },
    prompt() { return null; },
    scrollTo() {},
    FileReader: class {},
    Image: class {},
    TextDecoder,
    TextEncoder,
    Uint8Array
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx, { filename: 'index.html' });
  return { ctx, app, byId, toastLog, localStorage };
}

function response(status, { content, text, json } = {}) {
  const body = json || { choices: [{ message: { content: content || '{"reply":"ok"}' } }] };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text != null ? text : JSON.stringify(body)
  };
}

function scripted(ctx, steps) {
  const calls = [];
  ctx.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, auth: opts.headers.Authorization, model: body.model, temperature: body.temperature });
    const step = steps.shift();
    if (!step) throw new Error('unexpected fetch ' + body.model);
    if (step.network) throw new Error(step.network);
    return response(step.status, step);
  };
  return calls;
}

const auth = (k) => 'Bearer ' + k;

// Source still contains the owner's OpenRouter chain and no chat.html debug hook.
assert.match(html, /google\/gemma-4-26b-a4b-it:free/);
assert.match(html, /google\/gemma-4-31b-it:free/);
assert.match(html, /openrouter\/free/);
assert.doesNotMatch(html, /chat\.html/);
assert.doesNotMatch(html, /几个模型都在繁忙/);

// Default model and grok-4 migration.
{
  const { ctx, localStorage } = boot({ acc_model: 'grok-4' });
  assert.equal(localStorage.getItem('acc_model'), DEFAULT_MODEL);
  assert.equal(ctx.cfg().model, DEFAULT_MODEL);
  assert.equal(ctx.cfg().base, 'https://api.x.ai/v1');
}

// Legacy single acc_key still works. Full key stays out of the settings HTML.
{
  const secret = 'sk-SUPERSECRETKEY9999';
  const other = 'sk-OTHERKEY8888';
  const { ctx, app, byId, localStorage } = boot({ acc_key: secret });
  const calls = scripted(ctx, [{ status: 200 }]);
  assert.equal(await ctx.llm([{ role: 'user', content: 'hi' }]), '{"reply":"ok"}');
  assert.equal(calls[0].auth, auth(secret));
  assert.equal(calls[0].model, DEFAULT_MODEL);
  localStorage.setItem('acc_keys', JSON.stringify([secret, other]));
  ctx.settings();
  const page = app.innerHTML;
  assert.equal(page.includes(secret), false);
  assert.equal(page.includes('SUPERSECRET'), false);
  assert.equal(page.includes('OTHERKEY'), false);
  assert.equal(page.includes('9999'), true);
  assert.equal(page.includes('8888'), true);
  byId.get('s_k').value = secret + '\n' + other;
  byId.get('s_b').value = 'https://api.x.ai/v1';
  byId.get('s_m').value = 'grok-4';
  ctx.saveCfg();
  assert.equal(localStorage.getItem('acc_model'), DEFAULT_MODEL);
  assert.deepEqual(JSON.parse(localStorage.getItem('acc_keys')), [secret, other]);
  assert.equal(localStorage.getItem('acc_key'), secret);
  ctx.settings();
  assert.equal(app.innerHTML.includes(secret), false);
  assert.equal(app.innerHTML.includes('SUPERSECRET'), false);
}

// 429: next key, same model, then remember that key.
{
  const k1 = 'key-aaaa-1111', k2 = 'key-bbbb-2222';
  const { ctx, toastLog } = boot({ acc_keys: JSON.stringify([k1, k2]) });
  const calls = scripted(ctx, [{ status: 429, text: 'slow down ' + k1 }, { status: 200 }, { status: 200 }]);
  await ctx.llm([]);
  await ctx.llm([]);
  assert.deepEqual(calls.map((c) => c.auth), [auth(k1), auth(k2), auth(k2)]);
  assert.deepEqual(calls.map((c) => c.model), [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL]);
  assert.equal(toastLog.some((t) => t.includes('1111') && t.includes('限流')), true);
  assert.equal(toastLog.some((t) => t.includes(k1)), false);
}

// 401 drops the key for the rest of the session.
{
  const k1 = 'key-dead-aaaa', k2 = 'key-live-bbbb';
  const { ctx, toastLog } = boot({ acc_keys: JSON.stringify([k1, k2]) });
  const calls = scripted(ctx, [
    { status: 401, text: 'bad ' + k1 },
    { status: 200 },
    { status: 200 }
  ]);
  await ctx.llm([]);
  await ctx.llm([]);
  assert.deepEqual(calls.map((c) => c.auth), [auth(k1), auth(k2), auth(k2)]);
  assert.equal(toastLog.some((t) => t.includes('验证失败') && t.includes('aaaa')), true);
  assert.equal(toastLog.join('\n').includes(k1), false);
}

// 403 tries the next key, then the next model.
{
  const k1 = 'key-perm-1111', k2 = 'key-perm-2222';
  const { ctx, toastLog } = boot({
    acc_keys: JSON.stringify([k1, k2]),
    acc_model: 'no-such-model'
  });
  const calls = scripted(ctx, [{ status: 403, text: 'no' }, { status: 403, text: 'no' }, { status: 200 }]);
  await ctx.llm([]);
  assert.deepEqual(calls.map((c) => [c.model, c.auth]), [
    ['no-such-model', auth(k1)],
    ['no-such-model', auth(k2)],
    [DEFAULT_MODEL, auth(k1)]
  ]);
  assert.equal(toastLog.some((t) => t.includes('无权限') && t.includes('换下一把')), true);
  assert.equal(toastLog.some((t) => t.includes('正在切换模型')), true);
}

// 400/404 switches model only and keeps the same key.
{
  const k1 = 'key-model-1111', k2 = 'key-model-2222';
  const { ctx, toastLog } = boot({
    acc_keys: JSON.stringify([k1, k2]),
    acc_model: 'no-such-model'
  });
  const calls = scripted(ctx, [{ status: 400, text: 'unknown ' + k1 }, { status: 200 }]);
  await ctx.llm([]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.auth), [auth(k1), auth(k1)]);
  assert.deepEqual(calls.map((c) => c.model), ['no-such-model', DEFAULT_MODEL]);
  assert.equal(toastLog.some((t) => t.includes('模型不可用')), true);
  assert.equal(calls.some((c) => String(c.model).includes('gemma') || c.model === 'openrouter/free'), false);
}

// 408/5xx falls through xAI models, not OpenRouter slugs. Final error is the real status.
{
  const k1 = 'key-busy-1111';
  const { ctx, toastLog } = boot({ acc_keys: JSON.stringify([k1]) });
  const calls = scripted(ctx, [{ status: 503, text: 'unavailable' }, { status: 200 }]);
  await ctx.llm([]);
  assert.deepEqual(calls.map((c) => [c.model, c.auth]), [
    [DEFAULT_MODEL, auth(k1)],
    ['grok-4.7', auth(k1)]
  ]);
  assert.equal(toastLog.some((t) => t.includes('服务繁忙')), true);

  const fail = boot({ acc_keys: JSON.stringify([k1]), acc_model: 'no-such-model' });
  scripted(fail.ctx, [
    { status: 404, text: 'missing model' },
    { status: 404, text: 'missing ' + DEFAULT_MODEL },
    { status: 404, text: 'missing grok-4.7' }
  ]);
  await assert.rejects(fail.ctx.llm([]), (e) => {
    assert.match(e.message, /API错误 404/);
    assert.doesNotMatch(e.message, /几个模型都在繁忙/);
    assert.equal(e.message.includes(k1), false);
    return true;
  });
}

// OpenRouter base keeps the owner's fallback slugs. xAI base never requests them.
{
  const k1 = 'or-key-1234';
  const { ctx } = boot({
    acc_base: 'https://openrouter.ai/api/v1',
    acc_model: 'meta/llama',
    acc_keys: JSON.stringify([k1])
  });
  const calls = scripted(ctx, [{ status: 429, text: 'rate' }, { status: 429, text: 'rate' }, { status: 429, text: 'rate' }, { status: 200 }]);
  await ctx.llm([]);
  assert.deepEqual(calls.map((c) => c.model), [
    'meta/llama',
    'google/gemma-4-26b-a4b-it:free',
    'google/gemma-4-31b-it:free',
    'openrouter/free'
  ]);
}

// Two keys on OpenRouter: 429 stays on the same model before any slug change.
{
  const k1 = 'or-key-aaaa', k2 = 'or-key-bbbb';
  const { ctx } = boot({
    acc_base: 'https://openrouter.ai/api/v1',
    acc_model: 'meta/llama',
    acc_keys: JSON.stringify([k1, k2])
  });
  const calls = scripted(ctx, [{ status: 429, text: 'rate' }, { status: 200 }]);
  await ctx.llm([]);
  assert.deepEqual(calls.map((c) => [c.model, c.auth]), [
    ['meta/llama', auth(k1)],
    ['meta/llama', auth(k2)]
  ]);
}

// Error text echoes the key and must be stripped. A non-xAI base does not invent a 429 message.
{
  const secret = 'sk-SUPERSECRETKEY9999';
  const { ctx } = boot({
    acc_base: 'https://example.com/v1',
    acc_model: 'custom-model',
    acc_keys: JSON.stringify([secret])
  });
  scripted(ctx, [{ status: 400, text: 'invalid ' + secret + ' Bearer ' + secret }]);
  await assert.rejects(ctx.llm([]), (e) => {
    assert.match(e.message, /API错误 400/);
    assert.equal(e.message.includes(secret), false);
    assert.equal(e.message.includes('SUPERSECRET'), false);
    assert.doesNotMatch(e.message, /几个模型都在繁忙/);
    return true;
  });
}

// Network error switches to the next xAI model.
{
  const { ctx, toastLog } = boot({ acc_keys: JSON.stringify(['key-net-1234']) });
  const calls = scripted(ctx, [{ network: 'socket hang up' }, { status: 200 }]);
  await ctx.llm([]);
  assert.deepEqual(calls.map((c) => c.model), [DEFAULT_MODEL, 'grok-4.7']);
  assert.equal(toastLog.some((t) => t.includes('网络异常')), true);
}

// Replies and history stay on the chat that sent them.
{
  const { ctx } = boot({ acc_keys: JSON.stringify(['key-route-1234']) });
  const A = ctx.get('jinlian');
  const B = ctx.get('baochai');
  A.msgs = [{ r: 'me', t: '甲的话', ts: 1 }];
  B.msgs = [{ r: 'me', t: '乙的话', ts: 1 }];
  const beforeB = B.msgs.length;
  ctx.cur = B;
  ctx.tab = 'chat';
  let release;
  const gate = new Promise((res) => { release = res; });
  const calls = [];
  ctx.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    await gate;
    return response(200, { content: '{"reply":"来自甲","mood":"喜","affection":50,"relation":"宾客","thoughts":"想"}' });
  };
  const pending = ctx.speak(A, A);
  ctx.cur = B;
  release();
  await pending;
  assert.equal(A.msgs.at(-1).t, '来自甲');
  assert.equal(A.msgs.at(-1).r, 'ai');
  assert.equal(B.msgs.length, beforeB);
  assert.equal(JSON.stringify(B.msgs).includes('来自甲'), false);
  const blob = JSON.stringify(calls[0].messages);
  assert.equal(blob.includes('甲的话'), true);
  assert.equal(blob.includes('乙的话'), false);

  // send() captures the chat object even if cur changes before the response.
  const routed = boot({ acc_keys: JSON.stringify(['key-route-1234']) });
  routed.ctx.chat('jinlian');
  const input = [...routed.byId.values()].find((el) => el.id === 'txt');
  input.value = '只给金莲';
  let go;
  const wait = new Promise((res) => { go = res; });
  routed.ctx.fetch = async () => {
    await wait;
    return response(200, { content: '{"reply":"金莲答了"}' });
  };
  const talkP = new Promise((resolve) => {
    const orig = routed.ctx.talk;
    routed.ctx.talk = function (ch) {
      const p = orig.call(this, ch);
      resolve(p);
      return p;
    };
  });
  routed.ctx.send();
  const ch = routed.ctx.get('jinlian');
  routed.ctx.cur = routed.ctx.get('baochai');
  go();
  await talkP;
  assert.equal(ch.msgs.some((m) => m.t === '只给金莲' && m.r === 'me'), true);
  assert.equal(ch.msgs.some((m) => m.t === '金莲答了'), true);
  assert.equal(routed.ctx.get('baochai').msgs.some((m) => m.t === '金莲答了' || m.t === '只给金莲'), false);
}

// Unsent draft survives a rerender. Clearing chat rerenders the empty thread.
{
  const { ctx, byId } = boot();
  ctx.chat('jinlian');
  byId.get('txt').value = '未发送的草稿';
  byId.get('act').value = '摇扇';
  ctx.chat('jinlian');
  assert.equal(byId.get('txt').value, '未发送的草稿');
  assert.equal(byId.get('act').value, '摇扇');
  assert.equal(byId.get('act').classList.contains('hidden'), false);
  const ch = ctx.get('jinlian');
  ch.msgs.push({ r: 'me', t: 'UNIQUE_MSG_123', ts: 1 });
  ctx.render();
  assert.equal(byId.get('msgs').innerHTML.includes('UNIQUE_MSG_123'), true);
  ctx.clearChat();
  assert.equal(ch.msgs.length, 0);
  assert.equal(byId.get('msgs').innerHTML.includes('UNIQUE_MSG_123'), false);
}

// Group settings tolerate a missing member.
{
  const { ctx, byId } = boot();
  ctx.D.groups.push({ id: 'g1', name: '群', members: ['nope', 'baochai'], msgs: [], scenario: '', status: { mood: '热闹' } });
  ctx.chat('g1', 'set');
  const pane = byId.get('body').innerHTML;
  assert.equal(pane.includes('已删除'), true);
  assert.equal(pane.includes('薛宝钗'), true);
}

// Period characters get 书信/礼单 instead of a phone. Jinlian constraint is separate from 红楼梦.
{
  const { ctx, app, byId } = boot();
  const jin = ctx.get('jinlian');
  const bao = ctx.get('baochai');
  const sp = ctx.sysP(jin, '', jin);
  assert.equal(sp.includes('【词话约束】'), true);
  assert.equal(sp.includes('金瓶梅词话'), true);
  assert.equal(sp.includes('曹雪芹'), false);
  assert.equal(sp.includes('前八十回'), false);
  assert.equal(sp.includes('紫石街'), true);
  assert.equal(sp.includes('西门庆的女婿'), true);
  assert.equal(sp.includes('架空'), true);
  assert.ok(sp.lastIndexOf('【词话约束】') > sp.lastIndexOf('只输出JSON'));
  assert.equal(jin.background.includes('狮子街'), false);
  assert.equal(jin.canon, false);
  const bp = ctx.sysP(bao, '', bao);
  assert.equal(bp.includes('红楼梦'), true);
  assert.equal(bp.includes('【词话约束】'), false);
  assert.equal(ctx.sidePrompt(jin, 'phone').includes('礼单'), true);
  assert.equal(ctx.sidePrompt(jin, 'phone').includes('3条聊天记录'), false);
  assert.equal(ctx.sidePrompt({ id: 'modern', canon: false }, 'phone').includes('3条聊天记录'), true);
  ctx.chat('baochai', 'phone');
  assert.equal(app.innerHTML.includes('书信'), true);
  assert.equal(byId.get('body').innerHTML.includes('写书信／礼单'), true);
  ctx.D.chars.push({ id: 'modern', name: '小现', avatar: '🙂', personality: '', relation: '朋友', style: '', background: '', status: { mood: '平静', affection: 1, relation: '朋友', thoughts: '' }, msgs: [] });
  ctx.chat('modern', 'phone');
  assert.equal(app.innerHTML.includes('>手机<'), true);
  assert.equal(byId.get('body').innerHTML.includes('偷看TA的手机'), true);
}

// Saved jinlian cards migrate. Asahi leaves the character list, but a group that included Asahi keeps its messages.
{
  const old = {
    chars: [
      {
        id: 'jinlian', name: '潘金莲', avatar: '🌺', personality: '旧', relation: '旧关系', style: '旧',
        background: '终被武松杀于狮子街祭兄。她与女婿陈经济私情。',
        first: '旧开场',
        status: { mood: '怒', affection: 77, relation: '旧', thoughts: '这人三日两头往园子里来，眼神儿可不大老实，且看他今日又是个什么来意。' },
        msgs: [{ r: 'me', t: '保留这条', ts: 1 }],
        scenario: '西门府花园，葡萄架下，盛夏午后'
      },
      { id: 'asahi', name: '朝阳', avatar: '🌅', msgs: [{ r: 'ai', t: '朝阳的话', ts: 1 }], status: { mood: '开心' } }
    ],
    groups: [{ id: 'g-asahi', name: '有朝阳', members: ['asahi', 'jinlian'], msgs: [{ r: 'me', t: '群里的话', ts: 1 }, { r: 'ai', t: '朝阳在群里说的', who: '朝阳', ts: 2 }], status: { mood: '热闹' } }],
    album: [{ name: '朝阳', t: '相册一句', ts: 3 }]
  };
  const raw = JSON.stringify(old);
  const { ctx, localStorage } = boot({ acc_data: raw });
  const jin = ctx.get('jinlian');
  const group = ctx.D.groups.find((g) => g.id === 'g-asahi');
  assert.equal(ctx.get('asahi'), undefined);
  assert.ok(group);
  assert.equal(group.members.join(','), 'asahi,jinlian');
  assert.equal(group.msgs.map((m) => m.t).join('|'), '群里的话|朝阳在群里说的');
  assert.equal(ctx.D.album[0].t, '相册一句');
  assert.equal(localStorage.getItem('acc_data_premigrate'), raw);
  assert.equal(JSON.parse(localStorage.getItem('acc_data')).groups[0].msgs.length, 2);
  assert.equal(jin.msgs.some((m) => m.t === '保留这条'), true);
  assert.equal(jin.status.affection, 77);
  assert.equal(jin.status.mood, '怒');
  assert.equal(jin.cardVer, 'jpmei-2');
  assert.equal(jin.background.includes('狮子街'), false);
  assert.equal(jin.background.includes('紫石街'), true);
  assert.equal(jin.background.includes('西门庆的女婿'), true);
  assert.equal(jin.scenario.includes('架空'), true);
  assert.equal(jin.status.thoughts.includes('架空'), true);
  assert.equal(jin.canon, false);
}

// A card already migrated to jpmei-2 keeps the user's own text and chat.
{
  const kept = {
    chars: [{ id: 'jinlian', cardVer: 'jpmei-2', name: '潘金莲', personality: '用户改过', background: '用户背景', scenario: '用户情景', msgs: [{ r: 'me', t: '不要覆盖', ts: 1 }], status: { mood: '怒', affection: 80, relation: '旧', thoughts: '用户想法' }, avatar: '🌺', lorebook: [], examples: '', sysExtra: '' }],
    groups: [],
    album: []
  };
  const { ctx } = boot({ acc_data: JSON.stringify(kept) });
  const jin = ctx.get('jinlian');
  assert.equal(jin.personality, '用户改过');
  assert.equal(jin.background, '用户背景');
  assert.equal(jin.scenario, '用户情景');
  assert.equal(jin.msgs[0].t, '不要覆盖');
  assert.equal(jin.status.affection, 80);
}

// A null character entry must not abort startup.
{
  const { ctx } = boot({ acc_data: JSON.stringify({ chars: [null, { id: 'note', name: '便条', msgs: [{ r: 'me', t: '还在', ts: 1 }], status: { mood: '平静' } }], groups: [null], album: [null, { name: '甲', t: '一句', ts: 1 }] }) });
  assert.equal(ctx.get('jinlian').name, '潘金莲');
  assert.equal(ctx.get('note').msgs[0].t, '还在');
  assert.equal(ctx.D.groups.length, 0);
  assert.equal(ctx.D.album.length, 1);
}

// Longer keys are redacted before shorter prefixes, so no full key or leftover suffix remains.
{
  const { ctx } = boot();
  const short = 'fake-prefix';
  const long = 'fake-prefix-TAIL9999';
  const cleaned = ctx.sanitizeErr('err ' + long + ' and ' + short, [short, long]);
  assert.equal(cleaned.includes(long), false);
  assert.equal(cleaned.includes(short), false);
  assert.equal(cleaned.includes('TAIL9999'), false);
}

// Broken image reads reject instead of hanging, and the form can be submitted again.
{
  const readFail = boot();
  readFail.ctx.FileReader = class { readAsDataURL() { this.onerror(); } };
  await assert.rejects(readFail.ctx.readAvatar({}), (e) => e.message.includes('图片读取失败'));
  const decodeFail = boot();
  decodeFail.ctx.FileReader = class { readAsDataURL() { this.onload(); } };
  decodeFail.ctx.Image = class { set src(_) { this.onerror(); } };
  await assert.rejects(decodeFail.ctx.readAvatar({}), (e) => e.message.includes('图片解码失败'));
  await assert.rejects(decodeFail.ctx.readAvatar({}), (e) => e.message.includes('请换一张后重试'));
}

// Corrupt localStorage does not blank the page. A full disk does not throw out of save.
{
  const { ctx, toastLog } = boot({ acc_data: '{bad' });
  assert.equal(ctx.get('jinlian').name, '潘金莲');
  assert.equal(toastLog.some((t) => t.includes('损坏')), true);
  const orig = ctx.localStorage.setItem;
  ctx.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.doesNotThrow(() => ctx.S());
  ctx.localStorage.setItem = orig;
}

// Group replies still update the shared character status. This is existing behavior, kept on purpose.
{
  const { ctx } = boot({ acc_keys: JSON.stringify(['fake-key-1111']) });
  const jin = ctx.get('jinlian');
  const before = jin.status.affection;
  ctx.D.groups.push({ id: 'g-status', name: '群', members: ['jinlian'], msgs: [{ r: 'me', t: '群里一句', ts: 1 }], status: { mood: '热闹' } });
  ctx.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(body.model, 'grok-4.20-0309-non-reasoning');
    assert.equal(body.frequency_penalty, 0.3);
    assert.equal(body.temperature, 0.9);
    return response(200, { content: '群回复\n<<<STATUS>>>\n{"mood":"怒","affection":90,"relation":"变了","thoughts":"想"}' });
  };
  await ctx.talk(ctx.get('g-status'));
  assert.equal(before, 45);
  assert.equal(jin.status.affection, 90);
  assert.equal(jin.status.mood, '怒');
  assert.equal(ctx.get('g-status').msgs.some((m) => m.t === '群回复'), true);
  assert.equal(jin.msgs.some((m) => m.t === '群回复'), false);
}

assert.match(html, /maximum-scale=1/);
assert.match(html, /google\/gemma-4-26b-a4b-it:free/);
assert.match(html, /openrouter\/free/);

function sseResponse(parts, status = 200) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : '' },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= parts.length) return { done: true, value: undefined };
            const part = parts[i++];
            return { done: false, value: part instanceof Uint8Array ? part : enc.encode(part) };
          }
        };
      }
    },
    json: async () => { throw new Error('not json'); },
    text: async () => { throw new Error('not text'); }
  };
}

// SSE split across chunks, including a multibyte character and a cut STATUS marker. [DONE] ends the stream.
{
  const enc = new TextEncoder();
  const nihao = enc.encode('你好');
  const pieces = [
    enc.encode('data: {"choices":[{"delta":{"content":"'),
    nihao.slice(0, 1),
    nihao.slice(1),
    enc.encode('"}}]}\n\ndata: {"choices":[{"delta":{"content":"<<<STA"}}]}\r\n\r\n'),
    enc.encode('data: {"choices":[{"delta":{"content":"TUS>>>\\n{\\"mood\\":\\"喜\\",\\"affection\\":51,\\"relation\\":\\"友\\",\\"thoughts\\":\\"念\\"}"}}]}\n\n'),
    'data: [DONE]\n\n'
  ];
  const seen = [];
  const { ctx, byId } = boot({ acc_keys: JSON.stringify(['fake-stream-1111']) });
  ctx.chat('jinlian');
  let reads = 0;
  const res = sseResponse(pieces);
  const reader = res.body.getReader();
  res.body.getReader = () => ({
    async read() {
      if (reads > 0) {
        const htmlNow = byId.get('msgs') ? byId.get('msgs').innerHTML : '';
        seen.push(htmlNow);
      }
      reads += 1;
      return reader.read();
    }
  });
  ctx.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'grok-4.20-0309-non-reasoning');
    return res;
  };
  await ctx.talk(ctx.get('jinlian'));
  const jin = ctx.get('jinlian');
  const last = jin.msgs[jin.msgs.length - 1];
  assert.equal(last.t, '你好');
  assert.equal(last.t.includes('<<<STATUS>>>'), false);
  assert.equal(last.t.includes('affection'), false);
  assert.equal(jin.status.affection, 51);
  assert.equal(jin.status.mood, '喜');
  assert.equal(seen.length > 0, true);
  assert.equal(seen.some((htmlNow) => htmlNow.includes('你')), true);
  assert.equal(seen.some((htmlNow) => htmlNow.includes('<<<STATUS>>>') || htmlNow.includes('affection')), false);
  assert.equal(byId.get('msgs').innerHTML.includes('<<<STATUS>>>'), false);
  assert.equal(byId.get('msgs').innerHTML.includes('你好'), true);
}

// A 429 before any text, then a stream on the next key. Only the second reply is saved.
{
  const k1 = 'fake-stream-aaaa', k2 = 'fake-stream-bbbb';
  const { ctx } = boot({ acc_keys: JSON.stringify([k1, k2]) });
  const calls = [];
  ctx.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ model: body.model, auth: opts.headers.Authorization, stream: body.stream });
    if (calls.length === 1) return response(429, { text: 'slow ' + k1 });
    return sseResponse(['data: {"choices":[{"delta":{"content":"第二把"}}]}\n\n', 'data: [DONE]\n']);
  };
  const raw = await ctx.llm([], (t) => { if (t && t.includes(k1)) throw new Error('preview leaked key'); });
  assert.equal(raw, '第二把');
  assert.deepEqual(calls.map((c) => c.model), ['grok-4.20-0309-non-reasoning', 'grok-4.20-0309-non-reasoning']);
  assert.equal(calls[1].auth.endsWith('bbbb'), true);
  assert.equal(calls[0].auth.includes(k1) && raw.includes(k1), false);
}

// Stream dies after a partial token. The partial is not saved; the next model reply is.
{
  const secret = 'fake-stream-SECRET';
  const { ctx } = boot({ acc_keys: JSON.stringify([secret]) });
  ctx.chat('jinlian');
  let n = 0;
  ctx.fetch = async () => {
    n += 1;
    if (n === 1) {
      let i = 0;
      const parts = ['data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'];
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader() {
            return {
              async read() {
                if (i === 0) { i = 1; return { done: false, value: new TextEncoder().encode(parts[0]) }; }
                throw new Error('reset ' + secret);
              }
            };
          }
        }
      };
    }
    return response(200, { content: '完整句\n<<<STATUS>>>\n{"mood":"平","affection":46,"relation":"友","thoughts":"稳"}' });
  };
  await ctx.talk(ctx.get('jinlian'));
  const jin = ctx.get('jinlian');
  const last = jin.msgs[jin.msgs.length - 1];
  assert.equal(last.r, 'ai');
  assert.equal(last.t, '完整句');
  assert.equal(JSON.stringify(jin.msgs).includes('半截'), false);
  assert.equal(JSON.stringify(jin).includes(secret), false);
  assert.equal(n, 2);
}

// Provider returns ordinary JSON even though stream was requested.
{
  const { ctx } = boot({ acc_keys: JSON.stringify(['fake-json-1111']) });
  const calls = [];
  ctx.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      body: { getReader: () => { throw new Error('should use json'); } },
      json: async () => ({ choices: [{ message: { content: '{"reply":"旧格式","mood":"平","affection":40,"relation":"友","thoughts":"念"}' } }] }),
      text: async () => { throw new Error('no'); }
    };
  };
  ctx.chat('baochai');
  await ctx.talk(ctx.get('baochai'));
  const bao = ctx.get('baochai');
  const last = bao.msgs[bao.msgs.length - 1];
  assert.equal(last.t, '旧格式');
  assert.equal(last.t.includes('{'), false);
  assert.equal(calls[0].stream, true);
  assert.equal(bao.status.affection, 40);
}

// 400 that rejects stream falls back to a non-stream request on the same model.
{
  const { ctx } = boot({ acc_base: 'https://example.com/v1', acc_model: 'custom-model', acc_keys: JSON.stringify(['fake-nostream-1111']) });
  const calls = [];
  ctx.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.stream) return response(400, { text: 'unrecognized argument stream' });
    return response(200, { content: '退回整段' });
  };
  const text = await ctx.llm([{ role: 'user', content: 'hi' }]);
  assert.equal(text, '退回整段');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stream, true);
  assert.equal(calls[1].stream, undefined);
  assert.equal(calls[0].model, 'custom-model');
  assert.equal(calls[1].model, 'custom-model');
}

// Diary keeps the raw completion, while the in-progress card never shows the status block.
{
  const { ctx, byId } = boot({ acc_keys: JSON.stringify(['fake-diary-1111']) });
  ctx.chat('jinlian', 'diary');
  const gout = byId.get('gout');
  const previews = [];
  gout.insertAdjacentHTML = function () {
    const el = { id: 'ld', _tc: '' };
    Object.defineProperty(el, 'textContent', {
      get() { return this._tc; },
      set(v) { this._tc = String(v); previews.push(this._tc); }
    });
    byId.set('ld', el);
  };
  ctx.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"今日无事"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<<<STATUS>>>{\\"mood\\":\\"懒\\"}"}}]}\n\n',
    'data: [DONE]\n'
  ]);
  await ctx.gen('diary');
  const saved = ctx.get('jinlian').diary[0];
  assert.equal(saved.includes('今日无事'), true);
  assert.equal(saved.includes('<<<STATUS>>>'), true);
  assert.equal(previews.some((t) => t.includes('今日无事')), true);
  assert.equal(previews.some((t) => t.includes('<<<STATUS>>>') || t.includes('mood')), false);
}

console.log('fallback-routing tests passed');
