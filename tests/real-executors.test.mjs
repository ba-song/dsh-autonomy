import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../lib/store/db.js'
import { createRealExecutors } from '../lib/run/real-executors.js'
import { makeTempDir } from './helpers.mjs'

function fakeLlm(text) {
  return {
    async prepareCall() {
      return { config: {}, async *stream() { yield { type: 'text-delta', text } } }
    },
  }
}

test('real executors：日记/刷抖音/发QQ 均走服务，且不把当前 action 算进日限', async (t) => {
  const tmp = makeTempDir('autonomy-real-')
  t.after(() => tmp.cleanup())
  const { db } = openDb({ dbPath: `${tmp.dir}/a.db` })
  t.after(() => db.close())
  const self = 'self:real-test'
  let saved = null
  const memory = { async saveDiary({ text }) { saved = text; return { ok: true, id: 'd1' } } }
  const services = {
    llm: fakeLlm('今天我把窗边的光收进本子里了。'),
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    dyDouyin: { async feed() { return { ok: true, items: [{ videoId: '123', text: '一只猫' }] } } },
    dyChannel: { async sendText({ contactId, text }) { return { ok: true, data: { contactId, text } } } },
  }
  const ctx = { get: (name) => services[name] ?? null }
  const cfg = { dryRun: false, sendEnabled: true, outgoing: { ownerAllowlist: ['10001'] } }
  const real = createRealExecutors({ db, cfg, memory, ctx, getPersonaId: () => self, clock: () => Date.now() })

  assert.equal((await real.writeDiary({ actionId: 'a1' })).ok, true)
  assert.equal(saved.includes('窗边'), true)
  db.prepare('INSERT INTO actions(id,self_id,kind,status,created_at) VALUES(?,?,?,?,?)').run('done-1', self, 'write_diary', 'done', Date.now())
  assert.equal((await real.writeDiary({ actionId: 'a2' })).code, 'RATE_LIMIT_DAY')
  assert.equal((await real.browseDouyin({ actionId: 'a3' })).ok, true)
  assert.equal((await real.sendQQ({ actionId: 'a4' })).ok, true)
})
