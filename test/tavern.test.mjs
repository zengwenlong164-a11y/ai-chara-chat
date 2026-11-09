import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { TextDecoder } from 'node:util';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

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
    atob,
    TextDecoder,
    localStorage,
    document,
    fetch: async () => { throw new Error('fetch not stubbed'); },
    alert() {},
    confirm() { return true; },
    prompt() { return null; },
    scrollTo() {},
    FileReader: class {},
    Image: class {}
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
    calls.push({ url, auth: opts.headers.Authorization, body });
    const step = steps.shift();
    if (!step) throw new Error('unexpected fetch ' + body.model);
    return response(step.status, step);
  };
  return calls;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function makePng(card, keyword = 'chara') {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR', Buffer.alloc(13));
  const text = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1')
  ]);
  const textChunk = pngChunk('tEXt', text);
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, textChunk, iend]);
}

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '测试姬',
    description: '背景文本',
    personality: '性格文本',
    scenario: '情景文本',
    first_mes: '开场白',
    mes_example: '<START>\n{{user}}: 嗨\n{{char}}: 你好',
    system_prompt: '卡系统提示',
    post_history_instructions: '卡后置指令',
    character_book: {
      entries: [
        { keys: ['冷香丸'], content: '冷香丸条目内容', enabled: true },
        { keys: ['已禁用'], content: '不应出现', enabled: false },
        { keys: [], content: '常量条目', constant: true, enabled: true }
      ]
    }
  }
};

// PNG card parsing and tavernToChar mapping.
{
  const { ctx } = boot();
  const parsed = ctx.parsePngCard(toArrayBuffer(makePng(card)));
  assert.equal(parsed.data.name, '测试姬');

  const c = ctx.tavernToChar(parsed);
  assert.equal(c.name, '测试姬');
  assert.equal(c.background, '背景文本');
  assert.equal(c.personality, '性格文本');
  assert.equal(c.scenario, '情景文本');
  assert.equal(c.first, '开场白');
  assert.equal(c.examples.includes('你好'), true);
  assert.equal(c.sysExtra.includes('卡系统提示'), true);
  assert.equal(c.sysExtra.includes('卡后置指令'), true);
  assert.equal(c.lorebook.length, 2);
  assert.deepEqual([...c.lorebook[0].keys], ['冷香丸']);

  assert.throws(() => ctx.parsePngCard(toArrayBuffer(makePng(card, 'other'))));
}

// parseReply: status block, plain text, bad JSON, legacy protocol.
{
  const { ctx } = boot();
  const withBlock = ctx.parseReply('（她笑了笑）你来了。\n<<<STATUS>>>\n{"mood":"喜","affection":55,"relation":"友人","thoughts":"想"}');
  assert.equal(withBlock.reply, '（她笑了笑）你来了。');
  assert.equal(withBlock.status.affection, 55);
  assert.equal(withBlock.status.mood, '喜');

  const plain = ctx.parseReply('普通一句话');
  assert.equal(plain.reply, '普通一句话');
  assert.equal(plain.status, null);

  const bad = ctx.parseReply('正文在此\n<<<STATUS>>>\n{mood:坏,}');
  assert.equal(bad.reply, '正文在此');
  assert.equal(bad.status, null);
  assert.equal(bad.reply.includes('{'), false);
  assert.equal(bad.reply.includes('STATUS'), false);

  const legacy = ctx.parseReply('{"reply":"旧格式","mood":"平","affection":40,"relation":"友","thoughts":"念"}');
  assert.equal(legacy.reply, '旧格式');
  assert.equal(legacy.status.affection, 40);
}

// matchLore: keyword hit + constant entry, and a clean miss.
{
  const { ctx } = boot();
  const char = {
    lorebook: [
      { keys: ['金锁'], content: '金锁条目' },
      { keys: ['不存在的词'], content: '不应命中' },
      { keys: [], content: '常量内容', constant: true }
    ]
  };
  const chat = { msgs: [{ r: 'me', t: '我看见她项上的金锁了' }] };
  const hit = ctx.matchLore(char, chat);
  assert.equal(hit.includes('金锁条目'), true);
  assert.equal(hit.includes('常量内容'), true);
  assert.equal(hit.includes('不应命中'), false);

  const missChar = { lorebook: [{ keys: ['金锁'], content: '金锁条目' }, { keys: ['不存在的词'], content: '不应命中' }] };
  assert.equal(ctx.matchLore(missChar, { msgs: [{ r: 'me', t: '今天天气不错' }] }), '');
}

// RP wiring: cfg values and request body temperature/frequency_penalty.
{
  const { ctx } = boot({ acc_keys: JSON.stringify(['k-test-1234']), acc_temp: '1.5', acc_freq: '0', acc_ctx: '10' });
  assert.equal(ctx.cfg().temp, 1.5);
  assert.equal(ctx.cfg().ctxN, 10);

  const calls = scripted(ctx, [{ status: 200 }]);
  await ctx.llm([]);
  assert.equal(calls[0].body.temperature, 1.5);
  assert.equal('frequency_penalty' in calls[0].body, false);
}

{
  const { ctx } = boot({ acc_keys: JSON.stringify(['k-test-1234']), acc_temp: '1.5', acc_freq: '0.5', acc_ctx: '10' });
  const calls = scripted(ctx, [{ status: 200 }]);
  await ctx.llm([]);
  assert.equal(calls[0].body.frequency_penalty, 0.5);
}

console.log('tavern tests passed');
