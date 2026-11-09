import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

class El {
  constructor(id, byId) {
    this.id = id || '';
    this._byId = byId;
    this._html = '';
    this.value = '';
    this.checked = false;
    this.files = [];
    this.style = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  set innerHTML(v) {
    this._html = String(v);
    const re = /<[^>]*\bid="([^"]+)"[^>]*>/gi;
    let m;
    while ((m = re.exec(this._html))) {
      if (m[1] === 'app') continue;
      const el = new El(m[1], this._byId);
      this._byId.set(m[1], el);
    }
  }
  get innerHTML() { return this._html; }
  insertAdjacentHTML() {}
}

function boot(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const localStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const byId = new Map();
  const app = new El('app', byId);
  byId.set('app', app);
  const document = {
    querySelector: (sel) => { const m = /^#([\w:-]+)$/.exec(sel || ''); return m ? (byId.get(m[1]) || null) : null; },
    querySelectorAll: () => [],
    createElement: () => new El('', byId),
    body: { appendChild() {}, removeChild() {} }
  };
  const alerts = [];
  const confirms = [];
  const ctx = {
    console, setTimeout, clearTimeout, URL, localStorage, document,
    fetch: async () => { throw new Error('fetch not stubbed'); },
    alert(m) { alerts.push(String(m)); },
    confirm(m) { confirms.push(String(m)); return true; },
    prompt() { return null; },
    scrollTo() {},
    FileReader: class {},
    Image: class {},
    TextDecoder, TextEncoder, Uint8Array, DataView, atob, btoa, unescape, encodeURIComponent,
    Blob, File
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx, { filename: 'index.html' });
  return { ctx, byId, localStorage, alerts, confirms };
}

function jsonReply(content, usage) {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content } }], usage }),
    text: async () => ''
  };
}

const secret = 'super-secret-key-xyz';

// Plaza adds an adult public-domain template and does not alter the existing presets.
{
  const { ctx } = boot();
  const bao = ctx.get('baochai').background;
  const dai = ctx.get('daiyu').background;
  const jin = ctx.get('jinlian').background;
  assert.equal(ctx.get('jinlian').canon, false);
  assert.equal(ctx.get('baochai').canon, true);
  ctx.addPlaza('tpl_libai');
  assert.equal(ctx.get('tpl_libai').name, '李白');
  assert.equal(ctx.cur.id, 'tpl_libai');
  ctx.addPlaza('tpl_libai');
  assert.equal(ctx.D.chars.filter((c) => c.id === 'tpl_libai').length, 1);
  assert.equal(ctx.get('baochai').background, bao);
  assert.equal(ctx.get('daiyu').background, dai);
  assert.equal(ctx.get('jinlian').background, jin);
  assert.equal(ctx.PLAZA.every((t) => !/色情|裸体|性交/.test(t.personality + t.background + t.first)), true);
}

// Character card export round-trips through the existing importer and contains no API key.
{
  const { ctx, localStorage } = boot({ acc_key: secret, acc_keys: JSON.stringify([secret]) });
  const c = ctx.get('jinlian');
  c.lorebook = [{ keys: ['冷香'], content: '世界书一句', enabled: true }];
  c.examples = '示例对话';
  const card = ctx.charToTavern(c);
  const packed = JSON.stringify(card);
  assert.equal(packed.includes(secret), false);
  assert.equal(card.spec, 'chara_card_v2');
  assert.equal(card.data.character_book.entries[0].content, '世界书一句');
  const back = ctx.tavernToChar(card);
  assert.equal(back.lorebook[0].content, '世界书一句');
  assert.equal(back.examples, '示例对话');
  const png = ctx.encodeCardPng(card);
  const parsed = ctx.parsePngCard(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
  const fromPng = ctx.tavernToChar(parsed);
  assert.equal(fromPng.name, '潘金莲');
  assert.equal(fromPng.lorebook[0].keys.join(','), '冷香');
  const safe = ctx.backupPayload(false);
  assert.equal(JSON.stringify(safe).includes(secret), false);
  const risky = ctx.backupPayload(true);
  assert.equal(JSON.stringify(risky).includes(secret), true);
  assert.equal(localStorage.getItem('acc_key'), secret);
}

// Slash clear still asks for confirmation and does not wipe when declined.
{
  const { ctx, confirms } = boot();
  ctx.chat('jinlian');
  ctx.get('jinlian').msgs.push({ r: 'me', t: '留着', ts: 1 });
  ctx.confirm = (m) => { confirms.push(m); return false; };
  ctx.runCmd('clear');
  assert.equal(confirms.some((m) => m.includes('清空')), true);
  assert.equal(ctx.get('jinlian').msgs.some((m) => m.t === '留着'), true);
}

// Regenerating stores another version and switching restores that version's status exactly.
{
  const { ctx } = boot({ acc_keys: JSON.stringify(['fake-regen-1111']) });
  const answers = [
    '第一版\n<<<STATUS>>>\n{"mood":"平","affection":50,"relation":"友","thoughts":"旧"}',
    '第二版\n<<<STATUS>>>\n{"mood":"喜","affection":60,"relation":"友","thoughts":"新"}'
  ];
  ctx.fetch = async () => jsonReply(answers.shift());
  ctx.chat('jinlian');
  await ctx.talk(ctx.get('jinlian'));
  const jin = ctx.get('jinlian');
  assert.equal(jin.status.affection, 50);
  await ctx.regen();
  assert.equal(jin.msgs.at(-1).t, '第二版');
  assert.equal(jin.msgs.at(-1).versions.length, 2);
  assert.equal(jin.status.affection, 60);
  ctx.shiftVer(-1);
  assert.equal(jin.msgs.at(-1).t, '第一版');
  assert.equal(jin.status.affection, 50);
  ctx.shiftVer(1);
  assert.equal(jin.status.affection, 60);
  assert.notEqual(jin.status.affection, 110);
}

// Group regenerate updates only that speaker and does not add affections together.
{
  const { ctx } = boot({ acc_keys: JSON.stringify(['fake-regen-2222']) });
  const jin = ctx.get('jinlian');
  jin.status.affection = 50;
  ctx.D.groups.push({
    id: 'g-ver', name: '群', members: ['jinlian', 'baochai'], scenario: '',
    msgs: [{ r: 'me', t: '大家好', ts: 1 }, { r: 'ai', t: '第一句', who: '潘金莲', ts: 2, vi: 0, versions: [{ t: '第一句', status: { mood: '平', affection: 50, relation: '友', thoughts: '旧' }, usage: null }] }],
    status: { mood: '热闹' }
  });
  ctx.chat('g-ver');
  ctx.fetch = async () => jsonReply('第二句\n<<<STATUS>>>\n{"mood":"喜","affection":70,"relation":"友","thoughts":"新"}');
  await ctx.regen();
  assert.equal(ctx.get('g-ver').msgs.at(-1).t, '第二句');
  assert.equal(ctx.get('g-ver').msgs.at(-1).who, '潘金莲');
  assert.equal(jin.status.affection, 70);
  ctx.shiftVer(-1);
  assert.equal(jin.status.affection, 50);
  assert.equal(ctx.get('baochai').status.affection, 40);
}

// Import confirms, writes a backup, then replaces data.
{
  const { ctx, localStorage, confirms } = boot();
  const original = localStorage.getItem('acc_data');
  ctx.backupView();
  const incoming = { app: 'ai-chara-chat', version: 1, data: { chars: [{ id: 'newc', name: '新角色', msgs: [{ r: 'me', t: '导入的话', ts: 1 }], status: { mood: '平静', affection: 1, relation: '友', thoughts: '' } }], groups: [], album: [] }, settings: { model: 'grok-4.7' } };
  ctx.byId = null;
  const input = ctx.document.querySelector('#bak_file');
  input.files = [{ text: async () => JSON.stringify(incoming) }];
  ctx.confirm = (m) => { confirms.push(m); return false; };
  await ctx.importBackup();
  assert.equal(confirms.at(-1).includes('覆盖'), true);
  assert.equal(ctx.get('jinlian').name, '潘金莲');
  ctx.confirm = () => true;
  await ctx.importBackup();
  assert.equal(localStorage.getItem('acc_data_backup_latest'), original);
  assert.equal(ctx.get('newc').msgs[0].t, '导入的话');
  assert.equal(localStorage.getItem('acc_model'), 'grok-4.7');
}

// include_usage is removed and retried on the same model when the provider rejects it.
{
  const { ctx, localStorage } = boot({ acc_base: 'https://example.com/v1', acc_model: 'custom-model', acc_keys: JSON.stringify(['fake-usage-1111']) });
  const calls = [];
  ctx.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.stream_options) return { ok: false, status: 400, text: async () => 'unknown field stream_options', json: async () => ({}) };
    return jsonReply('用量回复', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  };
  const text = await ctx.llm([{ role: 'user', content: 'hi' }]);
  assert.equal(text, '用量回复');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'custom-model');
  assert.equal(calls[1].model, 'custom-model');
  assert.ok(calls[0].stream_options);
  assert.equal(calls[1].stream_options, undefined);
  assert.equal(calls[1].stream, true);
  const usage = JSON.parse(localStorage.getItem('acc_usage'));
  assert.equal(usage.prompt, 11);
  assert.equal(usage.completion, 7);
  assert.equal(usage.byModel['custom-model'].prompt, 11);
  assert.equal(ctx.estimateCost('custom-model', 11, 7), null);
  assert.equal(ctx.estimateCost('grok-4.7', 1000000, 1000000), 8);
  assert.equal(ctx.estimateCost('grok-4.20-0309-non-reasoning', 1000000, 1000000), 3.75);
}

console.log('features tests passed');
