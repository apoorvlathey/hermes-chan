/** Native Hermes Kanban only. Do not call CLI list or dashboard GET: both can write.
 *  The installed resolver owns board identity/current/path semantics; our SQL is read-only.
 *  No attachments, logs, sessions, config, secrets or arbitrary files are returned. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { KanbanBoards, KanbanDetail, KanbanTask, Transport } from '../shared/types'
import { sshBase } from './transport'

const run = promisify(execFile)
type Operation = 'boards' | 'tasks' | 'detail'
export interface KanbanCommand { file: string; args: string[] }
type Runner = (command: KanbanCommand) => Promise<string>
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Discover the installed interpreter without executing Hermes CLI (which can initialize state).
// Only inspect its launcher/shebang, never config/.env. -B suppresses bytecode writes.
const BOOTSTRAP = String.raw`
import os, shlex, shutil, subprocess, sys
from pathlib import Path
binary, reader = sys.argv[1:3]
candidates = []
seen = set()
def launcher(value, depth=0):
    if depth > 4: return
    value = os.path.expandvars(os.path.expanduser(value))
    # Keep the invoked path: resolving venv/bin/python loses pyvenv.cfg discovery.
    path = Path(os.path.abspath(shutil.which(value) or value))
    if str(path) in seen: return
    seen.add(str(path))
    if 'python' in path.name: candidates.insert(0, str(path))
    candidates.append(str(path.parent / 'python'))
    try:
        with path.open('rb') as f: head = f.read(4096).decode('utf-8')
        lines = head.splitlines()
        if lines and lines[0].startswith('#!'):
            parts = shlex.split(lines[0][2:])
            if parts and 'python' in Path(parts[0]).name: candidates.insert(0, parts[0])
        for line in lines[:12]:
            if line.startswith('exec '):
                parts = shlex.split(line[5:])
                if parts: launcher(parts[0], depth + 1)
    except (OSError, ValueError, UnicodeError): pass
launcher(binary)
candidates += ['python', 'python3']
for candidate in dict.fromkeys(candidates):
    executable = shutil.which(candidate)
    if not executable: continue
    try:
        result = subprocess.run([executable, '-B', '-c', "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('hermes_cli') else 1)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        if result.returncode == 0: os.execv(executable, [executable, '-B', '-c', reader, *sys.argv[3:]])
    except (OSError, subprocess.TimeoutExpired): pass
sys.exit('Compatible installed Hermes Python not found.')
`

/** Main-owned Transport only; the renderer may supply identifiers, never an interpreter/path/host. */
export function kanbanCommand(t: Transport, op: Operation, board?: string, taskId?: string): KanbanCommand {
  if (!['boards', 'tasks', 'detail'].includes(op)) throw new Error('Invalid Kanban operation')
  if (typeof t.profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(t.profile)) throw new Error('Invalid Hermes profile')
  if (op !== 'boards' && (typeof board !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(board))) throw new Error('Invalid Kanban board')
  if (op === 'detail' && (typeof taskId !== 'string' || !/^t_[a-zA-Z0-9_-]{1,128}$/.test(taskId))) throw new Error('Invalid Kanban task')
  if (t.hermes !== undefined && (typeof t.hermes !== 'string' || !t.hermes || /[\0\r\n]/.test(t.hermes))) throw new Error('Invalid Hermes installation')
  const args = ['-B', '-c', BOOTSTRAP, t.hermes ?? '$HOME/.local/bin/hermes', KANBAN_READER, op]
  if (op !== 'boards') args.push(board!)
  if (op === 'detail') args.push(taskId!)
  if (t.kind === 'local') return { file: 'python3', args }
  if (t.kind !== 'ssh' || typeof t.host !== 'string' || !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(t.host)) throw new Error('Invalid SSH host')
  return { file: 'ssh', args: [...sshBase(t.host), ['python3', ...args].map(quote).join(' ')] }
}

const execute: Runner = async ({ file, args }) => {
  const { stdout } = await run(file, args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

export async function readKanban(t: Transport, op: Operation, board?: string, taskId?: string, runner: Runner = execute): Promise<KanbanBoards | { tasks: KanbanTask[] } | KanbanDetail> {
  const command = kanbanCommand(t, op, board, taskId)
  let stdout: string
  try { stdout = await runner(command) }
  catch {
    // execFile errors include the whole command/source and native stderr. Do not expose them.
    // A timeout or 64 MiB safety ceiling is a complete failure, never a truncated success.
    throw new Error('Kanban read failed: verify Hermes is installed and the board is readable; timeout or response size limit may have been exceeded.')
  }
  try {
    const value: unknown = JSON.parse(stdout)
    const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    const strings = (v: unknown) => Array.isArray(v) && v.every(s => typeof s === 'string')
    const task = (v: unknown) => record(v) && ['id', 'title', 'status', 'assignee', 'blockReason'].every(k => typeof v[k] === 'string') && strings(v.parents) && strings(v.children)
    if (!record(value)) throw new Error('schema')
    if (op === 'boards') {
      if (typeof value.current !== 'string' || !Array.isArray(value.boards) || !value.boards.every(b => record(b) && typeof b.slug === 'string' && typeof b.name === 'string')) throw new Error('schema')
    } else if (op === 'tasks') {
      if (!Array.isArray(value.tasks) || !value.tasks.every(task)) throw new Error('schema')
    } else if (!task(value) || typeof value.body !== 'string' || typeof value.result !== 'string' || !Array.isArray(value.comments) || !value.comments.every(c => record(c) && typeof c.body === 'string' && typeof c.author === 'string')) throw new Error('schema')
    return value as unknown as KanbanBoards | { tasks: KanbanTask[] } | KanbanDetail
  } catch { throw new Error('Kanban response is incomplete or invalid; no partial results were loaded.') }
}

export const listKanbanBoards = (t: Transport) => readKanban(t, 'boards') as Promise<KanbanBoards>
export const listKanbanTasks = (t: Transport, board: string) => readKanban(t, 'tasks', board) as Promise<{ tasks: KanbanTask[] }>
export const getKanbanDetail = (t: Transport, board: string, taskId: string) => readKanban(t, 'detail', board, taskId) as Promise<KanbanDetail>

export const KANBAN_READER = String.raw`
import hashlib, json, re, shutil, sqlite3, stat, struct, sys, tempfile
from contextlib import closing, contextmanager
from pathlib import Path
from hermes_cli import kanban_db as kb

# Never let SQLite open the native path, even read-only: WAL readers can create
# SHM/WAL files. Only main/WAL bytes go into a private, disposable directory.
def identity(path):
    s = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(s.st_mode): raise ValueError('Unsupported database file')
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

def fingerprint(db):
    # Track only SQLite's known file set; SHM is observed, never copied/reused.
    # ctime additionally detects replacements or rewrites with restored mtime.
    paths = [db, Path(str(db) + '-wal'), Path(str(db) + '-shm'), Path(str(db) + '-journal')]
    before = {p: identity(p) for p in paths if p.exists()}
    if db not in before or paths[-1] in before: raise ValueError('Unavailable or journaled database')
    result = {}
    for p, metadata in before.items():
        with p.open('rb') as f:
            digest = hashlib.file_digest(f, 'sha256').digest()
        result[p] = (metadata, digest)
    if before != {p: identity(p) for p in paths if p.exists()}:
        raise ValueError('Database changed')
    return result

# Validate current-generation frames before private SQLite recovery. A salt
# mismatch ends the current WAL after RESTART reuse (SQLite retains old frames).
# Same-salt torn/checksum-invalid frames still fail closed, never hide commits.
def validate_wal(db):
    wal = Path(str(db) + '-wal')
    if not wal.exists() or wal.stat().st_size == 0: return
    with wal.open('rb') as f:
        header = f.read(32)
        if len(header) != 32: raise ValueError('Incomplete WAL')
        magic, version, page_size = struct.unpack('>III', header[:12])
        if magic not in (0x377f0682, 0x377f0683) or version != 3007000:
            raise ValueError('Unsupported WAL')
        if page_size < 512 or page_size > 65536 or page_size & (page_size - 1):
            raise ValueError('Unsupported WAL page size')
        endian = '<' if magic == 0x377f0682 else '>'
        def checksum(data, sums=(0, 0)):
            a, b = sums
            for x, y in struct.iter_unpack(endian + 'II', data):
                a = (a + x + b) & 0xffffffff
                b = (b + y + a) & 0xffffffff
            return a, b
        sums = checksum(header[:24])
        if sums != struct.unpack('>II', header[24:]): raise ValueError('Invalid WAL header')
        with db.open('rb') as main_file:
            main_header = main_file.read(100)
        main_page_size = int.from_bytes(main_header[16:18], 'big')
        if main_page_size == 1: main_page_size = 65536
        if main_header[:16] != b'SQLite format 3\x00' or main_page_size != page_size:
            raise ValueError('Mismatched WAL')
        while True:
            frame = f.read(24)
            if not frame: break
            if len(frame) != 24: raise ValueError('Incomplete WAL frame')
            # Check salt before reading payload: obsolete frames are not part of
            # this generation, even when no current frame has been written yet.
            if frame[8:16] != header[16:24]: break
            data = f.read(page_size)
            if len(data) != page_size or frame[:4] == b'\x00'*4:
                raise ValueError('Incomplete WAL frame')
            sums = checksum(data, checksum(frame[:8], sums))
            if sums != struct.unpack('>II', frame[16:24]): raise ValueError('Invalid WAL frame')

@contextmanager
def snapshot(db):
    for attempt in range(3):
        with tempfile.TemporaryDirectory(prefix='hermes-kanban-') as directory:
            copied = Path(directory) / 'board.db'
            try:
                before = fingerprint(db)
                for source in (db, Path(str(db) + '-wal')):
                    if source in before:
                        target = Path(str(copied) + str(source)[len(str(db)):])
                        shutil.copyfile(source, target)
                        with target.open('rb') as f:
                            if hashlib.file_digest(f, 'sha256').digest() != before[source][1]:
                                raise ValueError('Copy changed')
                if before != fingerprint(db): raise ValueError('Database changed')
                validate_wal(copied)
            except (OSError, ValueError):
                if attempt == 2: raise ValueError('Could not capture stable database')
                continue
            yield copied
            return
    raise ValueError('Could not capture stable database')

def text(value):
    if value is None: return ''
    if isinstance(value, bytes): return value.decode('utf-8', errors='replace')
    return str(value)

def main():
    operation = sys.argv[1]
    if operation == 'boards':
        boards = kb.list_boards(include_archived=True)
        return {'boards': [{'slug': b['slug'], 'name': str(b.get('name') or b['slug'])} for b in boards], 'current': kb.get_current_board()}
    if operation not in ('tasks','detail'): raise ValueError('Invalid Kanban operation')
    detail = operation == 'detail'
    task_id = sys.argv[3] if detail else ''
    if detail and not re.fullmatch(r't_[a-zA-Z0-9_-]{1,128}', task_id): raise ValueError('Invalid task')
    board = sys.argv[2]
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', board): raise ValueError('Invalid board')
    if board not in {b['slug'] for b in kb.list_boards(include_archived=True)}: raise ValueError('Unknown board')
    db = kb.kanban_db_path(board=board).resolve()
    if not db.exists():
        if any(Path(str(db) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
            raise ValueError('Orphan SQLite sidecars')
        if detail: raise ValueError('Unknown task')
        return {'tasks': []}
    with snapshot(db) as private_db, closing(sqlite3.connect(private_db)) as conn:
        conn.row_factory = sqlite3.Row
        conn.text_factory = lambda b: b.decode('utf-8', errors='replace')
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN') # One consistent snapshot for tasks, links and reasons.
        columns = {r['name'] for r in conn.execute('PRAGMA table_info(tasks)')}
        if not {'id','title','status','assignee'}.issubset(columns): raise ValueError('Incompatible schema')
        failure = 'last_failure_error' if 'last_failure_error' in columns else "'' AS last_failure_error"
        fields = 'id,title,status,assignee,' + failure + (',body,result' if detail else '')
        where, params = (' WHERE id = ?', (task_id,)) if detail else ('', ())
        rows = conn.execute('SELECT ' + fields + ' FROM tasks' + where + ' ORDER BY id', params).fetchall()
        if detail and not rows: raise ValueError('Unknown task')
        tasks = {text(r['id']): {'id': text(r['id']), 'title': text(r['title']), 'status': text(r['status']), 'assignee': text(r['assignee']), 'parents': [], 'children': [], 'blockReason': text(r['last_failure_error']) if r['status'] in ('blocked','triage') else ''} for r in rows}
        link_where, link_params = (' WHERE parent_id = ? OR child_id = ?', (task_id, task_id)) if detail else ('', ())
        for r in conn.execute('SELECT parent_id,child_id FROM task_links' + link_where + ' ORDER BY parent_id,child_id', link_params):
            parent, child = text(r['parent_id']), text(r['child_id'])
            if parent in tasks: tasks[parent]['children'].append(child)
            if child in tasks: tasks[child]['parents'].append(parent)
        event_where = ' AND task_id = ?' if detail else ''
        for r in conn.execute("SELECT task_id,payload FROM task_events WHERE kind IN ('blocked','block_loop_detected','dependency_wait')" + event_where + ' ORDER BY id', params):
            task = tasks.get(text(r['task_id']))
            if not task or task['status'] not in ('blocked','triage','todo'): continue
            try: reason = json.loads(text(r['payload'])).get('reason')
            except (ValueError, AttributeError): continue
            task['blockReason'] = text(reason)
        if detail:
            task = tasks[task_id]
            task.update(body=text(rows[0]['body']), result=text(rows[0]['result']))
            task['comments'] = [{'body': text(r['body']), 'author': text(r['author'])} for r in conn.execute('SELECT body,author FROM task_comments WHERE task_id = ? ORDER BY id', (task_id,))]
            return task
        return {'tasks': list(tasks.values())}

try:
    print(json.dumps(main(), ensure_ascii=True))
except Exception:
    # Never forward native tracebacks, paths or partial task bodies across IPC.
    print('Kanban read failed (missing task/board, inaccessible database or incompatible Hermes).', file=sys.stderr)
    sys.exit(1)
`
