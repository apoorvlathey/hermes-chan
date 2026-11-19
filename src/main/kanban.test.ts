import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { KANBAN_READER, kanbanCommand, readKanban } from './kanban'

// A generic installed-resolver fixture. Any core DB/mutation entrypoint is a trap.
const resolver = `
import json, os
from pathlib import Path
root = Path(os.environ['FIXTURE_ROOT'])
def list_boards(include_archived=True):
    return [{'slug':'default','name':'Default','db_path':'private-path'}, {'slug':'research','name':'Research'}]
def get_current_board(): return (root/'current').read_text().strip()
def kanban_db_path(board=None): return root / (board + '.db')
def forbidden(*a, **kw): raise AssertionError('mutating core entrypoint called')
connect = init_db = recompute_ready = forbidden
`
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hermes-chan-kanban-'))
  mkdirSync(path.join(root, 'hermes_cli'))
  writeFileSync(path.join(root, 'hermes_cli', '__init__.py'), '')
  writeFileSync(path.join(root, 'hermes_cli', 'kanban_db.py'), resolver)
  writeFileSync(path.join(root, 'current'), 'research\n')
  return root
}
function read(root: string, ...args: string[]) {
  return spawnSync('python3', ['-B', '-c', KANBAN_READER, ...args], {
    env: { ...process.env, PYTHONPATH: root, FIXTURE_ROOT: root }, encoding: 'utf8'
  })
}

function database(root: string, count = 125) {
  const seeded = spawnSync('python3', ['-B', '-c', `
import sqlite3, sys
c=sqlite3.connect(sys.argv[1])
c.executescript('''CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,status TEXT,assignee TEXT,body TEXT,result TEXT,last_failure_error TEXT);
CREATE TABLE task_links(parent_id TEXT,child_id TEXT);
CREATE TABLE task_events(id INTEGER PRIMARY KEY,task_id TEXT,kind TEXT,payload TEXT);
CREATE TABLE task_comments(id INTEGER PRIMARY KEY,task_id TEXT,body TEXT,author TEXT);''')
for i in range(int(sys.argv[2])):
    c.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)', ('t_%08x'%i,'Card '+str(i),['scheduled','triage','archived','blocked','todo','ready','running','review','done'][i%9],None,'private body','full result',None))
c.execute("INSERT INTO task_links VALUES('t_00000000','t_00000001')")
c.execute('INSERT INTO task_events VALUES(1,?,?,?)',('t_00000001','block_loop_detected','{"reason":"Needs input"}'))
c.execute("INSERT INTO task_comments VALUES(1,'t_00000001','Full comment','Reviewer')")
c.commit()
`, path.join(root, 'research.db'), String(count)], { encoding: 'utf8' })
  assert.equal(seeded.status, 0, seeded.stderr)
}

// Keep committed WAL after an abrupt writer exit; no open source SQLite connection
// while the reader runs. Removing SHM reproduces SQLite's source-side creation.
function walFixture(root: string) {
  database(root, 2)
  const result = spawnSync('python3', ['-B', '-c', `
import os, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('PRAGMA wal_autocheckpoint=0')
c.execute("UPDATE tasks SET title='Latest committed WAL' WHERE id='t_00000001'")
c.commit()
os._exit(0)
`, path.join(root, 'research.db')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  rmSync(path.join(root, 'research.db-shm'))
}

function snapshotCheck(root: string, hook = '', setup = '') {
  return spawnSync('python3', ['-B', '-c', `
import hashlib, json, os, pathlib, sqlite3, sys, tempfile
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
${setup}
def state():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None for p in root.iterdir()}
before = state()
original_connect = sqlite3.connect
def private_connect(database, *args, **kwargs):
    assert str(root / 'research.db') not in str(database), 'SQLite opened live source'
    return original_connect(database, *args, **kwargs)
sqlite3.connect = private_connect
${hook}
sys.argv = ['reader', 'tasks', 'research']
try:
    exec(${JSON.stringify(KANBAN_READER)})
finally:
    assert state() == before, 'source directory entries or hashes changed'
    assert not list(pathlib.Path(os.environ['TMPDIR']).iterdir()), 'temporary snapshot leaked'
`], { env: { ...process.env, PYTHONPATH: root, FIXTURE_ROOT: root, TMPDIR: path.join(root, 'private-temp') }, encoding: 'utf8' })
}

test('WAL snapshot includes latest commits without opening or changing source files and cleans private copies', () => {
  const root = fixture()
  try {
    walFixture(root)
    mkdirSync(path.join(root, 'private-temp'))
    const result = snapshotCheck(root)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).tasks[1].title, 'Latest committed WAL')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('live WAL writer and existing SHM remain unchanged while private recovery reads committed data only', () => {
  const root = fixture()
  try {
    walFixture(root)
    mkdirSync(path.join(root, 'private-temp'))
    const result = snapshotCheck(root, '', `
writer = sqlite3.connect(root / 'research.db')
writer.execute('PRAGMA wal_autocheckpoint=0')
writer.execute("UPDATE tasks SET title='Active writer committed' WHERE id='t_00000001'")
writer.commit()
writer.execute("UPDATE tasks SET title='Uncommitted must stay hidden' WHERE id='t_00000001'")
`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).tasks[1].title, 'Active writer committed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const recycledWalSetup = `
writer = sqlite3.connect(root / 'research.db')
writer.execute('PRAGMA journal_mode=WAL')
writer.execute('PRAGMA wal_autocheckpoint=0')
for i in range(30):
    writer.execute("UPDATE tasks SET title=? WHERE id='t_00000001'", ('Previous generation '+str(i),))
    writer.commit()
old_wal = (root / 'research.db-wal').read_bytes()
assert writer.execute('PRAGMA wal_checkpoint(RESTART)').fetchone()[0] == 0
writer.execute("UPDATE tasks SET title='Current generation committed' WHERE id='t_00000001'")
writer.commit()
wal = (root / 'research.db-wal').read_bytes()
size = int.from_bytes(wal[8:12], 'big') + 24
assert wal[40:48] == wal[16:24], 'no current-generation frame'
assert wal[32+size+8:32+size+16] != wal[16:24], 'no native recycled tail'
`

test('native RESTART reuse keeps current commits and ignores obsolete-salt WAL tail', () => {
  const root = fixture()
  try {
    database(root, 2)
    mkdirSync(path.join(root, 'private-temp'))
    const result = snapshotCheck(root, '', recycledWalSetup)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).tasks[1].title, 'Current generation committed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const tail of [false, true]) {
  test(`empty new WAL generation${tail ? ' with obsolete-salt frames' : ''} reads checkpointed main`, () => {
    const root = fixture()
    try {
      database(root, 2)
      mkdirSync(path.join(root, 'private-temp'))
      // Model the interval after the new header, before its first frame. All
      // bytes come from genuine RESTART generations, not invented checksums.
      const result = snapshotCheck(root, '', recycledWalSetup + `
(root / 'research.db-wal').write_bytes(wal[:32] + ${tail ? 'old_wal[32:]' : "b''"})
`)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).tasks[1].title, 'Previous generation 29')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('recycled WAL validates spilled uncommitted frames but only exposes the last commit', () => {
  const root = fixture()
  try {
    database(root, 2)
    mkdirSync(path.join(root, 'private-temp'))
    const result = snapshotCheck(root, '', recycledWalSetup + `
writer.execute('PRAGMA cache_size=2')
writer.execute('PRAGMA cache_spill=ON')
writer.execute("UPDATE tasks SET body=?,title='Uncommitted hidden' WHERE id='t_00000001'", ('x'*40000,))
spilled = (root / 'research.db-wal').read_bytes()
assert spilled[32+size+8:32+size+16] == spilled[16:24], 'no spilled current frame'
assert int.from_bytes(spilled[32+size+4:32+size+8], 'big') == 0, 'unexpected commit'
assert any(spilled[i+8:i+16] != spilled[16:24] for i in range(32, len(spilled), size)), 'no obsolete tail'
`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).tasks[1].title, 'Current generation committed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('same-salt checksum corruption before recycled tail still fails closed', () => {
  const root = fixture()
  try {
    database(root, 2)
    mkdirSync(path.join(root, 'private-temp'))
    const result = snapshotCheck(root, '', recycledWalSetup + `
corrupt = bytearray(wal)
corrupt[32+size-1] ^= 1
(root / 'research.db-wal').write_bytes(corrupt)
`)
    assert.equal(result.status, 1, result.stdout)
    assert.equal(result.stdout, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('invalid WAL checksums fail closed rather than silently returning stale main data', () => {
  const root = fixture()
  try {
    walFixture(root)
    const wal = path.join(root, 'research.db-wal')
    const bytes = readFileSync(wal)
    bytes[bytes.length - 1] ^= 1
    writeFileSync(wal, bytes)
    mkdirSync(path.join(root, 'private-temp'))
    const result = snapshotCheck(root)
    assert.equal(result.status, 1, result.stdout)
    assert.equal(result.stdout, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('orphan WAL without its main database fails closed instead of returning an empty board', () => {
  const root = fixture()
  try {
    walFixture(root)
    rmSync(path.join(root, 'research.db'))
    mkdirSync(path.join(root, 'private-temp'))
    const result = snapshotCheck(root)
    assert.equal(result.status, 1, result.stdout)
    assert.equal(result.stdout, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('snapshot retries a concurrent source change then succeeds, or fails after three unstable copies', () => {
  for (const always of [false, true]) {
    const root = fixture()
    try {
      walFixture(root)
      mkdirSync(path.join(root, 'private-temp'))
      const result = snapshotCheck(root, `
import shutil
original_copy = shutil.copyfile
copies = 0
def changing_copy(source, target):
    global copies
    result = original_copy(source, target)
    if pathlib.Path(source).name == 'research.db':
        copies += 1
        if ${always ? 'True' : 'copies == 1'}:
            info = source.stat()
            os.utime(source, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000))
    return result
shutil.copyfile = changing_copy
import atexit
atexit.register(lambda: None if copies == ${always ? 3 : 2} else os._exit(97))
`)
      assert.equal(result.status, always ? 1 : 0, result.stderr)
      if (always) assert.equal(result.stdout, '')
      else assert.equal(JSON.parse(result.stdout).tasks[1].title, 'Latest committed WAL')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('lists every persisted status and task without bodies, limits or writes', () => {
  const root = fixture()
  try {
    database(root)
    const before = readFileSync(path.join(root, 'research.db'))
    const result = read(root, 'tasks', 'research')
    assert.equal(result.status, 0, result.stderr)
    const { tasks } = JSON.parse(result.stdout)
    assert.equal(tasks.length, 125)
    assert.deepEqual(tasks[1], { id: 't_00000001', title: 'Card 1', status: 'triage', assignee: '', parents: ['t_00000000'], children: [], blockReason: 'Needs input' })
    assert.deepEqual(tasks[0].children, ['t_00000001'])
    assert.ok(tasks.some((t: {status: string}) => t.status === 'scheduled'))
    assert.ok(tasks.some((t: {status: string}) => t.status === 'archived'))
    assert.ok(!result.stdout.includes('private body'))
    assert.deepEqual(readFileSync(path.join(root, 'research.db')), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('detail is explicit, complete, narrow and missing identifiers never create a DB', () => {
  const root = fixture()
  try {
    database(root)
    const before = readFileSync(path.join(root, 'research.db'))
    const result = read(root, 'detail', 'research', 't_00000001')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      id: 't_00000001', title: 'Card 1', status: 'triage', assignee: '', parents: ['t_00000000'], children: [], blockReason: 'Needs input',
      body: 'private body', result: 'full result', comments: [{body: 'Full comment', author: 'Reviewer'}]
    })
    assert.deepEqual(readFileSync(path.join(root, 'research.db')), before)
    for (const args of [['detail','research','t_deadbeef'], ['tasks','../research'], ['tasks','unknown'], ['detail','research', "t_00000001' OR 1=1 --"]]) {
      const missing = read(root, ...args)
      assert.equal(missing.status, 1)
      assert.equal(missing.stdout, '')
      assert.ok(!missing.stderr.includes(root))
    }
    assert.deepEqual(JSON.parse(read(root, 'tasks', 'default').stdout), {tasks: []})
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('local and SSH commands use fixed readers, reject injection and preserve quoted installation paths', async () => {
  const t = {kind: 'local' as const, profile: 'default', hermes: "/opt/Hermes App/user's/bin/hermes"}
  const command = kanbanCommand(t, 'tasks', 'research')
  assert.equal(command.file, 'python3')
  assert.ok(command.args.includes(t.hermes))
  const ssh = kanbanCommand({kind: 'ssh', profile: 'reviewer', host: 'example-host'}, 'detail', 'research', 't_deadbeef')
  assert.equal(ssh.file, 'ssh')
  assert.ok(ssh.args.includes('BatchMode=yes'))
  assert.equal(ssh.args.at(-2), 'example-host')
  for (const board of ['../x', 'x; touch bad', 'X', '', 'x\n', 'x'.repeat(65)]) {
    assert.throws(() => kanbanCommand(t, 'tasks', board), /Invalid Kanban board/)
  }
  assert.throws(() => kanbanCommand(t, 'detail', 'research', "t_'; exit"), /Invalid Kanban task/)
  assert.throws(() => kanbanCommand({...t, profile: '../oops'}, 'boards'), /Invalid Hermes profile/)
  assert.throws(() => kanbanCommand({kind: 'ssh',profile:'default',host:'-oProxyCommand=bad'}, 'boards'), /Invalid SSH host/)
  await assert.rejects(readKanban(t, 'tasks', 'research', undefined, async () => { throw new Error('secret stderr') }), /^Error: Kanban read failed/)
  await assert.rejects(readKanban(t, 'tasks', 'research', undefined, async () => '{"tasks":[]'), /incomplete or invalid/)
})

test('transport rejects valid JSON with the wrong schema instead of returning partial or untyped data', async () => {
  const t = {kind: 'local' as const, profile:'default'}
  for (const value of ['null', '{}', '{"tasks":[{"id":"t_1"}]}']) {
    await assert.rejects(readKanban(t, 'tasks', 'research', undefined, async () => value), /incomplete or invalid/)
  }
  await assert.rejects(readKanban(t, 'boards', undefined, undefined, async () => '{"boards":[],"current":42}'), /incomplete or invalid/)
})

test('bootstrap preserves an isolated venv interpreter under restricted PATH and quoted launcher paths', () => {
  const root = fixture()
  try {
    const venv = path.join(root, "Hermes App user's", 'venv')
    const created = spawnSync('python3', ['-m', 'venv', '--without-pip', venv], { encoding: 'utf8' })
    assert.equal(created.status, 0, created.stderr)
    const python = path.join(venv, 'bin', 'python')
    const site = spawnSync(python, ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { encoding: 'utf8' }).stdout.trim()
    mkdirSync(path.join(site, 'hermes_cli'))
    writeFileSync(path.join(site, 'hermes_cli', '__init__.py'), '')
    writeFileSync(path.join(site, 'hermes_cli', 'kanban_db.py'), resolver)
    const launcher = path.join(root, "Hermes App user's", 'hermes')
    writeFileSync(launcher, `#!/bin/sh\nexec '${python.replace(/'/g, `'\\''`)}' -m hermes_cli \"$@\"\n`)
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/usr/bin:/bin', FIXTURE_ROOT: root }
    delete env.PYTHONPATH
    delete env.PYTHONHOME
    for (const kind of ['local', 'ssh'] as const) {
      const command = kanbanCommand({ kind, profile: 'default', hermes: launcher, host: 'example-host' }, 'boards')
      const result = kind === 'local'
        ? spawnSync(command.file, command.args, { env, encoding: 'utf8' })
        : spawnSync('/bin/sh', ['-c', command.args.at(-1)!], { env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).current, 'research')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('fixed bootstrap executes local and quoted SSH payloads against generic fixtures', () => {
  const root = fixture()
  try {
    database(root)
    const env = { ...process.env, PYTHONPATH: root, FIXTURE_ROOT: root }
    const local = kanbanCommand({kind:'local',profile:'default'}, 'tasks', 'research')
    const result = spawnSync(local.file, local.args, { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).tasks.length, 125)
    const remote = kanbanCommand({kind:'ssh',host:'example-host',profile:'default',hermes: "/opt/Hermes App/user's/hermes"}, 'detail', 'research', 't_00000001')
    const sshShell = spawnSync('/bin/sh', ['-c', remote.args.at(-1)!], { env, encoding: 'utf8' })
    assert.equal(sshShell.status, 0, sshShell.stderr)
    assert.equal(JSON.parse(sshShell.stdout).comments[0].body, 'Full comment')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('responses above the default subprocess buffer stay complete and missing DBs are not created', async () => {
  const root = fixture()
  try {
    database(root, 1205)
    const large = 'x'.repeat(1_100_000)
    const seed = spawnSync('python3', ['-B', '-c', `
import sqlite3, sys
c=sqlite3.connect(sys.argv[1])
c.execute("UPDATE tasks SET body=? WHERE id='t_00000001'", ('x'*1100000,))
c.commit()
`, path.join(root,'research.db')], {encoding:'utf8'})
    assert.equal(seed.status,0,seed.stderr)
    const result = await readKanban({kind:'local',profile:'default'}, 'detail','research','t_00000001', async command => {
      const r = spawnSync(command.file,command.args,{env:{...process.env,PYTHONPATH:root,FIXTURE_ROOT:root},encoding:'utf8',maxBuffer:4*1024*1024})
      assert.equal(r.status,0,r.stderr)
      return r.stdout
    })
    assert.ok('body' in result)
    assert.equal(result.body,large)
    assert.equal(JSON.parse(read(root,'tasks','research').stdout).tasks.length,1205)
    const absent = path.join(root,'default.db')
    assert.deepEqual(JSON.parse(read(root,'tasks','default').stdout),{tasks:[]})
    assert.equal(spawnSync('python3',['-c','import pathlib,sys; print(pathlib.Path(sys.argv[1]).exists())',absent],{encoding:'utf8'}).stdout.trim(),'False')
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('board summaries use installed resolver and exact current, exposing no paths', () => {
  const root = fixture()
  try {
    const before = readFileSync(path.join(root, 'current'))
    const result = read(root, 'boards')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      boards: [{ slug: 'default', name: 'Default' }, { slug: 'research', name: 'Research' }], current: 'research'
    })
    assert.deepEqual(readFileSync(path.join(root, 'current')), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
