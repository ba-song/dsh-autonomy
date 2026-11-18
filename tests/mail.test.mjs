/** 邮件通道：发送限流/失败、收件 home/审计/游标、HTML/附件/截断、runner 安全 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startPlugin, withServices, makeClock, makeTempDir, mockPersona, mockMemory } from './helpers.mjs'
import { createMailRunner } from '../lib/mail/runner.js'

const PERSONA = 'self:test-mail'

function fakeRunner({ sendResult = { ok: true, to: ['owner@example.com'] }, messages = [], owners = ['owner@example.com'] } = {}) {
  const calls = { send: [], poll: [] }
  return {
    calls,
    owners: () => owners,
    async send(input) { calls.send.push(input); return sendResult },
    async poll(input) { calls.poll.push(input); return { ok: true, messages } },
  }
}

function open({ runner, mail = {}, memory = null, envMissing = false } = {}) {
  const tmp = makeTempDir('autonomy-mail-')
  const homeDir = join(tmp.dir, 'home')
  mkdirSync(join(tmp.dir, 'mail'), { recursive: true })
  const envFile = join(tmp.dir, 'mail', 'mail.env')
  if (!envMissing) writeFileSync(envFile, 'SMTP_USER=fake@example.com\nSMTP_PASS=fake-pass-not-real\nMAIL_TO=owner@example.com\n')
  const calls = { followup: [], saveEmail: [] }
  const h = () => ({ agent: { status: 'idle', async followup(m) { calls.followup.push(m); return { ok: true } }, dispose() {} } })
  const agents = { get: () => null, create: () => h(), resume: () => h() }
  const env = startPlugin({
    dir: tmp.dir,
    mailRunner: runner,
    cfg: { enabled: true, dryRun: false, mail: { enabled: true, envFile, pollSeconds: 300, ...mail }, home: { enabled: true, cwd: homeDir, minIntervalMin: 60, maxIntervalMin: 60, deliverLog: join(tmp.dir, 'deliver.log'), logPath: join(tmp.dir, 'autonomy.log') } },
    services: { ...withServices({ persona: mockPersona({ selfId: PERSONA }), memory: memory ?? mockMemory() }), agents, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    clock: makeClock(),
  })
  return { env, calls, tmp, cleanup: () => { env.cleanup(); tmp.cleanup() } }
}
const textOf = (m) => (Array.isArray(m.content) ? m.content.map((c) => c.text ?? '').join(' ') : String(m.content))

test('mail / send：body 走 runner，成功；限流分钟/小时；失败码', async (t) => {
  const runner = fakeRunner()
  const ctx = open({ runner, mail: { minGapSec: 60, maxPerHour: 6 } })
  t.after(ctx.cleanup)
  const ok = await ctx.env.api.mail.send({ subject: 's', body: '正文' })
  assert.equal(ok.ok, true)
  assert.equal(runner.calls.send[0].body, '正文')
  const second = await ctx.env.api.mail.send({ subject: 's', body: 'again' })
  assert.equal(second.code, 'MAIL_RATE_LIMIT_MIN')

  const ctx2 = open({ runner: fakeRunner({ sendResult: { ok: false, code: 'MAIL_SEND_FAILED', error: 'boom' } }) })
  t.after(ctx2.cleanup)
  const fail = await ctx2.env.api.mail.send({ body: 'x' })
  assert.equal(fail.code, 'MAIL_SEND_FAILED')
  const audit = ctx2.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='mail_send' AND code='MAIL_SEND_FAILED'").get()
  assert.equal(audit.n, 1)
})

test('mail / send：每小时 6 封上限', async (t) => {
  const runner = fakeRunner()
  const ctx = open({ runner, mail: { minGapSec: 0, maxPerHour: 6 } })
  t.after(ctx.cleanup)
  const now = ctx.env.clock.now()
  const arr = [now - 6 * 60_000, now - 5 * 60_000, now - 4 * 60_000, now - 3 * 60_000, now - 2 * 60_000, now - 90_000]
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('mail.sentAt',?,?)").run(JSON.stringify(arr), now)
  const r = await ctx.env.api.mail.send({ body: 'x' })
  assert.equal(r.code, 'MAIL_RATE_LIMIT_HOUR')
})

test('mail / 收件：owner 投递一次 + 陌生人只审计 + 游标推进', async (t) => {
  const ownerList = ['owner@example.com', 'owner2@example.com']
  const probe = open({ runner: fakeRunner(), mail: { ownerAddresses: ownerList } })
  t.after(probe.cleanup)
  assert.deepEqual(probe.env.api.cfg.mail.ownerAddresses, ownerList)
  const runner = fakeRunner({
    messages: [
      { uid: 1, from: '主人 <owner@example.com>', subject: 's', text: 'hello home', messageId: 'email:1' },
      { uid: 2, from: ownerList[0], subject: 'qq1', text: 'qq owner 1', messageId: 'email:2' },
      { uid: 3, from: ownerList[1], subject: 'qq2', text: 'qq owner 2', messageId: 'email:3' },
      { uid: 4, from: 'stranger@example.com', subject: 'spam', text: 'bad', messageId: 'email:4' },
    ],
  })
  const ctx = open({ runner, mail: { ownerAddresses: ownerList } })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  const r = await ctx.env.api.pollMail()
  assert.equal(r.ok, true)
  assert.equal(r.delivered, 3)
  assert.equal(r.strangers, 1)
  assert.equal(ctx.calls.followup.length, 3)
  assert.ok(textOf(ctx.calls.followup[0]).includes('hello home'))
  const audit = ctx.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='mail_inbound' AND code='STRANGER'").get()
  assert.equal(audit.n, 1)
  assert.equal(ctx.env.api.status().mail.uidCursor, 4)
  assert.equal(runner.calls.poll[0].cursor, 0)
})

test('mail / 收件：投递失败不推进游标，下轮重试', async (t) => {
  const runner = fakeRunner({ messages: [{ uid: 5, from: 'owner@example.com', text: 'retry me', messageId: 'email:5' }] })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('pause.all',?,?)").run(JSON.stringify({ on: true, until: null }), ctx.env.clock.now())
  const r = await ctx.env.api.pollMail()
  assert.equal(r.ok, false)
  assert.equal(ctx.calls.followup.length, 0)
  assert.equal(ctx.env.api.status().mail.uidCursor, 0)
})

test('mail / 同一 UID 不重复投', async (t) => {
  const runner = fakeRunner({ messages: [{ uid: 7, from: 'owner@example.com', text: 'once', messageId: 'email:7' }] })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  await ctx.env.api.pollMail()
  await ctx.env.api.pollMail()
  assert.equal(ctx.calls.followup.length, 1)
  assert.equal(runner.calls.poll.at(-1).cursor, 7)
})

test('mail / 附件说明 + 超长截断 + status 字段', async (t) => {
  const runner = fakeRunner({ messages: [{ uid: 9, from: 'owner@example.com', text: 'x'.repeat(9000), hasAttachments: true, attachmentCount: 2, messageId: 'email:9' }] })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  const r = await ctx.env.api.pollMail()
  assert.equal(r.ok, true)
  const body = textOf(ctx.calls.followup[0])
  assert.ok(body.includes('含 2 个附件，已忽略'))
  assert.ok(body.includes('[已截断]'))
  assert.ok(body.length <= 8200)
  const st = ctx.env.api.status().mail
  for (const k of ['enabled', 'lastPollAt', 'lastInbound', 'lastError', 'uidCursor']) assert.ok(k in st)
  assert.equal(st.uidCursor, 9)
})

test('mail / runner：body stdin、argv 不含正文/密码', async (t) => {
  const tmp = makeTempDir('autonomy-mail-runner-')
  t.after(() => tmp.cleanup())
  const envFile = join(tmp.dir, 'mail.env')
  writeFileSync(envFile, 'SMTP_USER=u@example.com\nSMTP_PASS=secret-pass\nMAIL_TO=owner@example.com\n')
  let captured = null
  const execFileImpl = (file, args, opts, cb) => {
    let input = ''
    const child = { stdin: { end: (s) => { input = s; captured.input = s } } }
    captured = { file, args, opts, input }
    setImmediate(() => cb(null, JSON.stringify({ ok: true, to: ['owner@example.com'] }), ''))
    return child
  }
  const runner = createMailRunner({ execFileImpl, envFile, sendScript: '/tmp/send.py', pollScript: '/tmp/poll.py' })
  const r = await runner.send({ subject: 's', body: 'TOP-SECRET-BODY' })
  assert.equal(r.ok, true)
  assert.equal(captured.input, 'TOP-SECRET-BODY')
  assert.equal(captured.args.some((a) => a.includes('TOP-SECRET-BODY')), false)
  assert.equal(captured.args.some((a) => a.includes('secret-pass')), false)
  assert.equal(captured.file, 'python3')
})

test('mail / python HTML 转纯文本', (t) => {
  const tmp = makeTempDir('autonomy-mail-html-')
  t.after(() => tmp.cleanup())
  const out = execFileSync('python3', ['-c', `import importlib.util,sys; spec=importlib.util.spec_from_file_location('mp','${join(process.cwd(), 'scripts/mail/mail-poll.py')}'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(m.html_to_text('<b>你好</b><p>世界</p>'))`], { encoding: 'utf8' })
  assert.equal(out.trim().split('\n').join(''), '你好世界')
})

test('mail / dy_mail_send 工具 owner 门禁 + 正常发送', async (t) => {
  const runner = fakeRunner()
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  const tool = ctx.env.registered.find((r) => r.name === 'dy_mail_send')
  assert.ok(tool)
  const owner = { agent: { session: { header: { id: 'home-1', cwd: join(ctx.tmp.dir, 'home') } } } }
  const r = JSON.parse((await tool.execute({ subject: 'hi', body: 'body' }, owner)).detail)
  assert.equal(r.ok, true)
  const denied = JSON.parse((await tool.execute({ body: 'x' }, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } })).detail)
  assert.equal(denied.ok, false)
})


test('mail / 默认不限流：连续两封都成功，审计不含正文', async (t) => {
  const runner = fakeRunner()
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  const a = await ctx.env.api.mail.send({ subject: '一', body: 'BODY-SECRET-ONE' })
  const b = await ctx.env.api.mail.send({ subject: '二', body: 'BODY-SECRET-TWO' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  const rows = ctx.env.api.db.prepare("SELECT note,data_json FROM action_log WHERE event='mail_send' ORDER BY id").all()
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.equal(String(r.note).includes('BODY-SECRET'), false)
    assert.equal(String(r.data_json).includes('BODY-SECRET'), false)
  }
  assert.equal(ctx.env.api.cfg.mail.minGapSec, 0)
  assert.equal(ctx.env.api.cfg.mail.maxPerHour, 0)
})


test('mail / 默认 owner 地址为空，profile 可配置 QQ 邮箱', (t) => {
  const plain = open({ runner: fakeRunner() })
  t.after(plain.cleanup)
  assert.deepEqual(plain.env.api.cfg.mail.ownerAddresses, [])
  const configured = open({ runner: fakeRunner(), mail: { ownerAddresses: ['a@qq.com', 'b@qq.com'] } })
  t.after(configured.cleanup)
  assert.ok(configured.env.api.cfg.mail.ownerAddresses.length >= 2)
  assert.ok(configured.env.api.cfg.mail.ownerAddresses.every((a) => a.endsWith('@qq.com')))
})


test('mail / owner 邮件写 saveEmail 一次，失败不阻断 home', async (t) => {
  const calls = []
  const memory = {
    available: true,
    async saveEmail(input) { calls.push(input); return { ok: true, id: 'm1' } },
  }
  const runner = fakeRunner({ messages: [{ uid: 21, from: 'owner@example.com', to: 'me@example.com', subject: 's', date: '2026-11-07T00:00:00Z', text: 'remember me', messageId: 'email:21' }] })
  const ctx = open({ runner, memory })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  const r = await ctx.env.api.pollMail()
  assert.equal(r.delivered, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].messageId, 'email:21')
  assert.equal(calls[0].text, '[邮件·主人·#21] s\nremember me')
  assert.equal(calls[0].to, 'me@example.com')
  assert.equal(ctx.calls.followup.length, 1)
  const audit = ctx.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='mail_memory' AND code='OK'").get()
  assert.equal(audit.n, 1)

  const badMemory = {
    available: true,
    async saveEmail() { throw new Error('memory down') },
  }
  const ctx2 = open({ runner: fakeRunner({ messages: [{ uid: 22, from: 'owner@example.com', text: 'still deliver', messageId: 'email:22' }] }), memory: badMemory })
  t.after(ctx2.cleanup)
  await ctx2.env.api.home.awake({ personaId: PERSONA })
  ctx2.calls.followup.length = 0
  const r2 = await ctx2.env.api.pollMail()
  assert.equal(r2.delivered, 1)
  assert.equal(ctx2.calls.followup.length, 1)
  const failAudit = ctx2.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='mail_memory' AND code!='OK'").get()
  assert.equal(failAudit.n, 1)
})

test('mail / 陌生人不写 saveEmail，重复 uid 不重复写', async (t) => {
  const calls = []
  const memory = { available: true, async saveEmail(input) { calls.push(input); return { ok: true, id: 'm' } } }
  const runner = fakeRunner({ messages: [
    { uid: 31, from: 'stranger@example.com', text: 'spam', messageId: 'email:31' },
    { uid: 32, from: 'owner@example.com', text: 'owner', messageId: 'email:32' },
  ] })
  const ctx = open({ runner, memory })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  await ctx.env.api.pollMail()
  await ctx.env.api.pollMail()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].messageId, 'email:32')
  assert.equal(ctx.env.api.db.prepare("SELECT COUNT(1) AS n FROM action_log WHERE event='mail_memory' AND note LIKE '%uid=31%'").get().n, 0)
})

test('mail / reply：默认 To=最后一封主人、Re 主题、引用头、审计无正文', async (t) => {
  const runner = fakeRunner({ messages: [{ uid: 40, from: '主人 <owner@example.com>', to: 'me@example.com', subject: 'hello', date: '2026-11-07T00:00:00Z', text: '原信', messageId: 'email:40' }] })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  await ctx.env.api.pollMail()
  assert.equal(textOf(ctx.calls.followup[0]).includes('回信'), false)
  const meta = JSON.parse(ctx.env.api.db.prepare("SELECT value FROM meta WHERE key='mail.lastOwner'").get().value)
  assert.equal(meta.uid, 40)
  assert.equal(meta.messageId, 'email:40')

  runner.calls.send.length = 0
  const r = await ctx.env.api.mail.reply({ body: '收到，回你' })
  assert.equal(r.ok, true)
  assert.equal(r.to, 'owner@example.com')
  assert.equal(r.subject, 'Re: hello')
  const sent = runner.calls.send.at(-1)
  assert.deepEqual(sent.to, ['owner@example.com'])
  assert.equal(sent.subject, 'Re: hello')
  assert.equal(sent.inReplyTo, 'email:40')
  assert.equal(sent.references, 'email:40')
  const audit = ctx.env.api.db.prepare("SELECT note,data_json FROM action_log WHERE event='mail_reply' ORDER BY id DESC LIMIT 1").get()
  assert.ok(audit.note.includes('body_len=5'))
  assert.equal(String(audit.note).includes('收到，回你'), false)
  assert.equal(String(audit.data_json).includes('收到，回你'), false)
})

test('mail / reply：无邮件/非 owner/超长拒绝', async (t) => {
  const runner = fakeRunner()
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  assert.equal((await ctx.env.api.mail.reply({ body: 'x' })).code, 'NO_MAIL')
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('mail.lastOwner',?,?)").run(JSON.stringify({ from: 'stranger@example.com', subject: 's', messageId: 'email:1' }), ctx.env.clock.now())
  assert.equal((await ctx.env.api.mail.reply({ body: 'x' })).code, 'E_NOT_OWNER')
  ctx.env.api.db.prepare("UPDATE meta SET value=? WHERE key='mail.lastOwner'").run(JSON.stringify({ from: 'owner@example.com', subject: 's', messageId: 'email:1' }))
  assert.equal((await ctx.env.api.mail.reply({ body: 'x'.repeat(5001) })).code, 'BODY_TOO_LONG')
  assert.equal(runner.calls.send.length, 0)
})

test('mail / reply 工具 owner 门禁', async (t) => {
  const ctx = open({ runner: fakeRunner() })
  t.after(ctx.cleanup)
  const tool = ctx.env.registered.find((r) => r.name === 'dy_mail_reply')
  assert.ok(tool)
  const denied = JSON.parse((await tool.execute({ body: 'x' }, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } })).detail)
  assert.equal(denied.ok, false)
})

test('mail / 定时器挂载并调用 pollMail；启动补拉', async (t) => {
  const runner = fakeRunner({ messages: [] })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  const mailInterval = ctx.env.intervalJobs.find((j) => j.ms === 300_000)
  assert.ok(mailInterval, 'mail interval 应挂 300s')
  const before = ctx.env.api.status().mail.lastPollAt
  mailInterval.cb()
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(ctx.env.api.status().mail.lastPollAt >= (before ?? 0), 'poll 应更新 lastPollAt')
  assert.ok(runner.calls.poll.length >= 1)
  const boot = ctx.env.timeoutJobs.find((j) => j.ms === 5_000)
  assert.ok(boot, '应有启动补拉 5s timer')
})

test('mail / poll 失败写 lastError，cursor 不推进', async (t) => {
  const runner = fakeRunner()
  runner.poll = async () => ({ ok: false, code: 'MAIL_POLL_FAILED', error: 'imap down' })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  const r = await ctx.env.api.pollMail()
  assert.equal(r.ok, false)
  const st = ctx.env.api.status().mail
  assert.equal(st.lastError.code, 'MAIL_POLL_FAILED')
  assert.equal(st.uidCursor, 0)
})

test('mail / 手动补拉工具 owner 门禁 + 调用', async (t) => {
  const runner = fakeRunner({ messages: [{ uid: 18, from: 'owner@example.com', text: '补拉', messageId: 'email:18' }] })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  const tool = ctx.env.registered.find((r) => r.name === 'dy_mail_poll')
  assert.ok(tool)
  const owner = { agent: { session: { header: { id: 'home-1', cwd: join(ctx.tmp.dir, 'home') } } } }
  const r = JSON.parse((await tool.execute({}, owner)).detail)
  assert.equal(r.ok, true)
  assert.equal(r.delivered, 1)
  assert.equal(ctx.env.api.status().mail.uidCursor, 18)
  const denied = JSON.parse((await tool.execute({}, { agent: { session: { header: { id: 'x', cwd: '/tmp/other' } } } })).detail)
  assert.equal(denied.ok, false)
})


test('dyMail / 服务暴露：send owner 校验/默认主题/reply/ownerAddresses', async (t) => {
  const runner = fakeRunner()
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  const svc = ctx.env.provided.dyMail
  assert.ok(svc)
  assert.equal(typeof svc.send, 'function')
  assert.equal(typeof svc.reply, 'function')
  assert.ok(svc.ownerAddresses().includes('owner@example.com'))
  const r = await svc.send({ to: 'owner@example.com', body: 'hello' })
  assert.equal(r.ok, true)
  assert.equal(r.subject, '汐的邮件')
  assert.deepEqual(runner.calls.send.at(-1).to, ['owner@example.com'])
  const bad = await svc.send({ to: 'stranger@example.com', body: 'x' })
  assert.equal(bad.code, 'E_NOT_OWNER')
  ctx.env.api.db.prepare("INSERT INTO meta(key,value,updated_at) VALUES('mail.lastOwner',?,?)").run(JSON.stringify({ from: 'owner@example.com', subject: '旧主题', messageId: 'email:9' }), ctx.env.clock.now())
  const rep = await svc.reply({ body: '收到' })
  assert.equal(rep.ok, true)
  assert.equal(rep.subject, 'Re: 旧主题')
  assert.equal(runner.calls.send.at(-1).inReplyTo, 'email:9')
})

test('dyMail / 缺 env/禁用时服务仍存在并返回码', async (t) => {
  const ctx = open({ runner: fakeRunner(), envMissing: true })
  t.after(ctx.cleanup)
  const svc = ctx.env.provided.dyMail
  assert.ok(svc)
  assert.equal((await svc.send({ to: 'owner@example.com', body: 'x' })).code, 'MAIL_ENV_MISSING')

  const ctx2 = open({ runner: fakeRunner(), mail: { enabled: false } })
  t.after(ctx2.cleanup)
  assert.equal((await ctx2.env.provided.dyMail.send({ to: 'owner@example.com', body: 'x' })).code, 'MAIL_DISABLED')
})


test('mail / 入站头：[邮件·主人·#uid] 主题单行、正文保留/默认无提示，saveEmail 同格式', async (t) => {
  const mem = []
  const memory = { available: true, async saveEmail(input) { mem.push(input); return { ok: true, id: 'm' } } }
  const runner = fakeRunner({ messages: [{ uid: 51, from: 'owner@example.com', subject: '  A\nB  ', text: '第一行\n第二行', messageId: 'email:51' }] })
  const ctx = open({ runner, memory })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  await ctx.env.api.pollMail()
  const text = textOf(ctx.calls.followup[0])
  assert.ok(text.startsWith('[邮件·主人·#51] A B'), text.slice(0, 40))
  assert.ok(text.includes('第一行\n第二行'))
  assert.equal(text.includes('回信'), false)
  assert.ok(mem[0].text.startsWith('[邮件·主人·#51] A B'))
  assert.ok(mem[0].text.includes('第一行'))
})


test('mail / replyHint 默认关；开启时每会话只首次带 dy_say 提示', async (t) => {
  const runner = fakeRunner({ messages: [
    { uid: 61, from: 'owner@example.com', subject: '一', text: 'A', messageId: 'email:61' },
    { uid: 62, from: 'owner@example.com', subject: '二', text: 'B', messageId: 'email:62' },
  ] })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  await ctx.env.api.pollMail()
  assert.equal(textOf(ctx.calls.followup[0]).includes('回信'), false)
  assert.equal(textOf(ctx.calls.followup[1]).includes('回信'), false)

  const runner2 = fakeRunner({ messages: [
    { uid: 63, from: 'owner@example.com', subject: '一', text: 'A', messageId: 'email:63' },
    { uid: 64, from: 'owner@example.com', subject: '二', text: 'B', messageId: 'email:64' },
  ] })
  const ctx2 = open({ runner: runner2, mail: { replyHint: true } })
  t.after(ctx2.cleanup)
  await ctx2.env.api.home.awake({ personaId: PERSONA })
  ctx2.calls.followup.length = 0
  await ctx2.env.api.pollMail()
  assert.ok(textOf(ctx2.calls.followup[0]).includes("dy_say channel:'email'"))
  assert.equal(textOf(ctx2.calls.followup[1]).includes('回信'), false)
})

test('mail / 附件路径行：普通/危险/跳过写入正文', async (t) => {
  const runner = fakeRunner({ messages: [{
    uid: 70, from: 'owner@example.com', subject: '附件', text: '看附件', messageId: 'email:70',
    attachments: [
      { name: 'a.pdf', path: '/tmp/email-att/a-1.pdf', dangerous: false },
      { name: 'b.exe', path: '/tmp/email-att/b-2.exe', dangerous: true },
      { name: 'big.bin', skipped: 'max_file' },
    ],
  }] })
  const ctx = open({ runner })
  t.after(ctx.cleanup)
  await ctx.env.api.home.awake({ personaId: PERSONA })
  ctx.calls.followup.length = 0
  await ctx.env.api.pollMail()
  const text = textOf(ctx.calls.followup[0])
  assert.ok(text.includes('[附件] /tmp/email-att/a-1.pdf'))
  assert.ok(text.includes('[附件·危险，仅保存不执行] /tmp/email-att/b-2.exe'))
  assert.ok(text.includes('[附件跳过] big.bin（max_file）'))
})

test('mail / Python 附件保存：正常/危险/超限跳过', (t) => {
  const tmp = makeTempDir('autonomy-att-')
  t.after(() => tmp.cleanup())
  const py = `
import importlib.util, json, sys
from email.message import EmailMessage
spec = importlib.util.spec_from_file_location('mp', sys.argv[2])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
msg = EmailMessage(); msg.set_content('body')
msg.add_attachment(b'12345678', maintype='application', subtype='octet-stream', filename='ok.txt')
msg.add_attachment(b'ABCDEFGH', maintype='application', subtype='octet-stream', filename='bad.exe')
msg.add_attachment(b'X' * 20, maintype='application', subtype='octet-stream', filename='over.bin')
m.MAX_FILE_BYTES = 10
print(json.dumps(m.save_attachments(msg, 77, sys.argv[1]), ensure_ascii=False))
`
  const out = JSON.parse(execFileSync('python3', ['-c', py, tmp.dir, join(process.cwd(), 'scripts/mail/mail-poll.py')], { encoding: 'utf8' }))
  const ok = out.find((x) => x.name === 'ok.txt')
  const bad = out.find((x) => x.name === 'bad.exe')
  const over = out.find((x) => x.name === 'over.bin')
  assert.ok(ok?.path && ok.dangerous === false)
  assert.ok(bad?.path && bad.dangerous === true)
  assert.equal(over?.skipped, 'max_file')
})
