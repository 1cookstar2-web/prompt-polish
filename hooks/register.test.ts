import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HEDGE_MS, INSTRUCTIONS, MODEL, guard, skip, tuning, typed } from './register'

// The test runner's own timer: a call crosses to the engine and back over real event-loop turns
declare const setTimeout: (fn: () => void, ms: number) => unknown

// The engine underneath: what reaches the session, which surfaces draw, what Opus replies, the state folder, the tuner
const engine = (on: On, { surfaces = ['desktop'], reply = 'Fix the login bug in `src/auth.ts`.' as string | null, saved = undefined as string | undefined, tuned = '', replies = {} as Record<string, string | null | (string | null)[]>, files = {} as Record<string, string>, stall = 0, env = {} as Record<string, string>, hang = false } = {}) => {
  const asked: { model: string; prompt: string; system?: string; effort?: string; timeoutMs?: number }[] = []
  const toasts: string[] = []
  const written: Record<string, string> = {}
  const ran: string[][] = []
  const clock = mock.clock(on, { now: 1000 })
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('env.get', ($, e) => ({ value: ({ HOME: '/home/u', ...env } as Record<string, string>)[(e as unknown as { name: string }).name] as never }))
  on('command.register', () => ({ value: undefined as never }))
  on('fs.read', ($, e) => {
    const path = (e as unknown as { path: string }).path
    const own = files[path] ?? (path.endsWith('/hooks/register.tsx') ? files['register.tsx'] : undefined)
    return own !== undefined ? { value: own as never } : saved === undefined ? { deny: 'ENOENT' } : { value: saved as never }
  })
  on('fs.write', async ($, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    written[path] = text
    // `hang`: a disk that never answers
    if (hang) await new Promise(() => {})
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    ran.push([...(e as unknown as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: tuned, stderr: '' } as never }
  })
  on('model.complete', async ($, e, next) => {
    asked.push(e)
    // The first `stall` calls hang until they are cut, as a stalled API call does
    if (stall > 0 && !e.system?.startsWith('You grade')) {
      stall--
      await new Promise<void>(cut => next.signal.addEventListener('abort', () => cut()))
      return { value: { isAnswered: false, reason: 'aborted' } as never }
    }
    // The bench's judge answers with a grade; a prompt listed in `replies` gets its own reply
    if (e.system?.startsWith('You grade')) {
      const fidelity = e.model === 'claude-fable-5-1' ? 3 : 5
      return { value: { isAnswered: true, text: `{"fidelity":${fidelity},"language":4,"claude_code":4,"brevity":5,"note":"${e.model}"}`, usage: {} } as never }
    }
    const own = Object.entries(replies).find(([k]) => e.prompt.includes(k))
    // A list answers each call in turn: a reply that fails first and works on the retry
    const reply_ = own ? (Array.isArray(own[1]) ? (own[1].length > 1 ? own[1].shift()! : own[1][0]!) : own[1]) : reply
    return { value: reply_ === null ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } as never : { isAnswered: true, text: `${reply_}\n`, usage: {} } as never }
  })
  on('ui.toast', async ($, e) => {
    toasts.push(typeof e === 'string' ? e : (e as { text: string }).text)
    if (hang) await new Promise(() => {})
    return { value: undefined }
  })
  const events = () => Object.entries(written).filter(([p]) => p.startsWith('/home/u/.local/state/prompt-polish/events/')).map(([, t]) => JSON.parse(t))
  return { asked, clock, toasts, events, ran, written }
}
const ide = { kind: 'composer' } as const
// Lets the tuner run the mod starts after the prompt went in (it does not hold the prompt) finish
// (each engine call crosses real event-loop turns, so a few timer turns, not only microtasks)
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(done => setTimeout(() => done(undefined), 0))
}

test('a typed prompt reaches the session as Opus 5.5 rewrote it, the typed words kept beside it for Claude', async ($, on) => {
  const { asked, events, ran } = engine(on)
  const r = await $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false })
  expect(r.text).toBe('Fix the login bug in `src/auth.ts`.')
  expect(r.context?.at(-1)).toContain('fix teh login bug in src/auth.ts')
  expect(asked).toHaveLength(1)
  expect(asked[0]?.model).toBe(MODEL)
  expect(asked[0]?.effort).toBe('low')
  expect(asked[0]?.prompt).toBe('<prompt>\nfix teh login bug in src/auth.ts\n</prompt>')
  expect(asked[0]?.system).toContain('never answer')
  expect(events()).toMatchObject([{ words: 6, effort: 'low', outcome: 'rewritten', v: INSTRUCTIONS }])
  await settle()
  expect(ran[0]?.slice(0, 2)).toEqual(['python3', expect.stringMatching(/\/tune\/tune\.py$/)])
  expect(ran[0]?.slice(2)).toEqual(['--state', '/home/u/.local/state/prompt-polish'])
})

test('a session started with PROMPT_POLISH_OFF set sends its prompts as written, with no model call', async ($, on) => {
  const m = engine(on, { env: { PROMPT_POLISH_OFF: '1' } })
  expect((await $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false })).text).toBe('fix teh login bug in src/auth.ts')
  expect(m.asked).toEqual([])
})

test('PROMPT_POLISH_STATE moves the events and the tuner to another folder (a latency bench leaves the real numbers alone)', async ($, on) => {
  const m = engine(on, { env: { PROMPT_POLISH_STATE: '/tmp/bench-state' } })
  await $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false })
  expect(Object.keys(m.written).filter(p => p.startsWith('/tmp/bench-state/events/'))).toHaveLength(1)
  expect(m.events()).toEqual([])
  await settle()
  expect(m.ran[0]?.slice(2)).toEqual(['--state', '/tmp/bench-state'])
})

test('phone, SDK and headless prompts, commands, short replies and \\-prefixed ones go as typed', async ($, on) => {
  const { asked } = engine(on)
  expect((await $.prompt.submit({ text: 'fix teh login bug', origin: { kind: 'bridge' }, wait: false })).text).toBe('fix teh login bug')
  expect((await $.prompt.submit({ text: '/compact keep teh plan', origin: ide, wait: false })).text).toBe('/compact keep teh plan')
  expect((await $.prompt.submit({ text: 'yes do it', origin: ide, wait: false })).text).toBe('yes do it')
  expect((await $.prompt.submit({ text: 'yes', origin: ide, wait: false })).text).toBe('yes')
  expect((await $.prompt.submit({ text: '\\grep "teh" exactly as I typed', origin: ide, wait: false })).text).toBe('grep "teh" exactly as I typed')
  expect(asked).toHaveLength(0)
  expect(typed(ide, ['desktop'])).toBe(true)
  expect(typed(ide, ['terminal'])).toBe(true)
  expect(typed(ide, [])).toBe(false)
  expect(typed({ kind: 'sdk' }, ['desktop'])).toBe(false)
  expect(skip('!ls -la here')).toBe(true)
  expect(skip('/compact')).toBe(true)
  expect(skip('/plugin:cmd with some args here')).toBe(true)
})

test('a prompt opening with a file path is polished, not taken for a command', async ($, on) => {
  const prompt = '/home/me/app/docs/audit.md read this audit report in full and decide on which ones are worth testing.'
  const { asked } = engine(on, { replies: { audit: 'Read /home/me/app/docs/audit.md in full and decide which recommendations are worth testing.' } })
  expect(skip(prompt)).toBe(false)
  expect((await $.prompt.submit({ text: prompt, origin: ide, wait: false })).text).toBe('Read /home/me/app/docs/audit.md in full and decide which recommendations are worth testing.')
  expect(asked).toHaveLength(1)
})

test('the tuner\'s settings drive the call, and what it changed shows as a toast', async ($, on) => {
  const { asked, toasts } = engine(on, { saved: JSON.stringify({ effort: 'medium', minWords: 6, timeoutMs: 20000 }), tuned: 'effort medium -> high: 3 of 10 rewrites were refused\n' })
  expect((await $.prompt.submit({ text: 'fix teh login bug now', origin: ide, wait: false })).text).toBe('fix teh login bug now')
  await $.prompt.submit({ text: 'please fix teh login bug now', origin: ide, wait: false })
  expect(asked.map(a => [a.effort, a.timeoutMs])).toEqual([['medium', 20000]])
  await settle()
  expect(toasts).toEqual(['prompt-polish tuned: effort medium -> high: 3 of 10 rewrites were refused'])
  expect(tuning('{"effort":"turbo","minWords":0}')).toEqual({ effort: 'low', minWords: 4, timeoutMs: 60000 })
})

test('a prompt Opus finds clean goes as typed, recorded unchanged', async ($, on) => {
  const { events } = engine(on, { reply: '=' })
  expect((await $.prompt.submit({ text: 'Fix the login bug in src/auth.ts.', origin: ide, wait: false })).text).toBe('Fix the login bug in src/auth.ts.')
  expect(events()).toMatchObject([{ outcome: 'unchanged' }])
})

// 2026-10-06 history: 14 of 12,459 replies were "=" with Opus's own notes around it, and went in as the prompt
test('an = reply with deliberation around it still means unchanged', async ($, on) => {
  const { events } = engine(on, { reply: '=\n\nWait — must reply with only "=".\n\n=' })
  expect((await $.prompt.submit({ text: 'Did you dedupe these accounts and hosts?', origin: ide, wait: false })).text).toBe('Did you dedupe these accounts and hosts?')
  expect(events()).toMatchObject([{ outcome: 'unchanged' }])
  expect(guard('Turn on the Shield and check the APK', 'Turn on the Shield and check the APK.\n\nWait, the instructions say that if the prompt is already clear, reply with =.')).toBe('added commentary')
  expect(guard('rewrite this commit message so its clearer', 'Rewrite this commit message so it is clearer.')).toBeUndefined()
  // 2026-10-07: a prompt asking for a one-word reply, reworded naturally, is not talk about the mod's own instructions
  expect(guard('after that pls reply with the word green only, theres no need for tools here', 'After that, please reply with only the word "green". There\'s no need for tools here.')).toBeUndefined()
  expect(guard('Did you dedupe these accounts and hosts?', 'Did you dedupe these accounts and hosts?\n\nWait — must reply with only "=".')).toBe('added commentary')
  expect(guard('Check the hosts', 'Check the hosts.\n\nReply with only =')).toBe('added commentary')
})

test('a rewrite that loses a path, flag or quote, or adds a preface, is refused: the prompt goes as typed', async ($, on) => {
  const { toasts, events, asked } = engine(on, { reply: 'Fix the login bug in the auth module.' })
  expect((await $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false })).text).toBe('fix teh login bug in src/auth.ts')
  expect(asked).toHaveLength(2) // the repair call lost it again
  expect(toasts).toEqual(['Prompt sent as typed: the rewrite lost src/auth.ts'])
  expect(events()).toMatchObject([{ outcome: 'guarded', guard: 'lost src/auth.ts', original: 'fix teh login bug in src/auth.ts' }])
  expect(guard('run deploy.sh --no-checks', 'Run deploy.sh without checks.')).toBe('lost --no-checks')
  expect(guard('say "ping pong" back', 'Reply with pong.')).toBe('lost "ping pong"')
  expect(guard('see https://x.dev/a?b=1 now', 'See https://x.dev/a now.')).toBe('lost https://x.dev/a?b=1')
  expect(guard('fix it', "Here's the rewritten prompt: Fix it.")).toBe('added a preface')
  // 2026-10-06 sweep: "Example of a playlist…" rewritten as "Here's an example of a playlist…" was refused as a preface
  expect(guard('Example of a playlist that works', "Here's an example of a playlist that works.")).toBeUndefined()
  // 2026-10-06 bench: Opus wrote the user's Claude.md as CLAUDE.md, and the guard refused it
  expect(guard('add it to the global Claude.md file', 'Add it to the global CLAUDE.md file.')).toBeUndefined()
  expect(guard('add it to notes.md', 'Add it to the notes.')).toBe('lost notes.md')
  // 2026-10-06 audit: a dictated "3.js" that Opus rightly wrote as Three.js was refused as a lost file name
  expect(guard('something like 3.js, etc.', 'Three.js is one example.')).toBeUndefined()
  // 2026-10-06 bench: a rewrite that moved the comma out of "compacted conversation," was refused
  expect(guard('the app said "compacted conversation," then froze', 'The app said "compacted conversation", then froze.')).toBeUndefined()
  expect(guard('look at /home/me/app/x.ts.', 'Look at `/home/me/app/x.ts`.')).toBeUndefined()
  expect(guard('before /SlashMods and/or later', 'Before /SlashMods, and/or later.')).toBeUndefined()
  // 2026-10-06 docs: Opus 5.5 reads pasted text by its <pasted_content> tags; a pasted log or fenced block must go through untouched
  const paste = 'why does this fail\n<pasted_content id="ab12">\nErorr: teh build failed\n</pasted_content id="ab12">'
  expect(guard(paste, 'Why does this fail?\n<pasted_content id="ab12">\nError: the build failed\n</pasted_content id="ab12">')).toBe('changed pasted text')
  expect(guard(paste, 'Why does this fail?\n<pasted_content id="ab12">\nErorr: teh build failed\n</pasted_content id="ab12">')).toBeUndefined()
  // 2026-10-06 round 9: Opus's own deliberation came back around the prompt it had decided to leave alone
  expect(guard("(mid-turn) Your response also isn't showing", "Already clear. Missing period only. Reply with corrected version.  (mid-turn) Your response also isn't showing.")).toBe('added commentary')
  expect(guard('Fix the tests', 'Fix the tests.')).toBeUndefined()
  expect(guard('This site can’t be reached: DNS address could not be found', 'I get this error when I open the site: This site can’t be reached: DNS address could not be found')).toBeUndefined()
  expect(guard('fix this\n```\nconst x = teh()\n```', 'Fix this:\n```\nconst x = the()\n```')).toBe('changed pasted text')
})

test('a refused rewrite gets one more call naming every string it lost, and the fixed rewrite goes in', async ($, on) => {
  const text = 'fix teh login bug in src/auth.ts with --fast'
  const { toasts, events, asked } = engine(on, { replies: { 'src/auth.ts': ['Fix the login bug in the auth module.', 'Fix the login bug in src/auth.ts with --fast.'] } })
  expect((await $.prompt.submit({ text, origin: ide, wait: false })).text).toBe('Fix the login bug in src/auth.ts with --fast.')
  expect(asked[1]!.prompt).toBe(`<prompt>\n${text}\n</prompt>\n\n<previous_rewrite>\nFix the login bug in the auth module.\n</previous_rewrite>\n\nYour previous rewrite dropped or changed text that has to be kept exactly. Write the rewrite again, keeping everything else you had, and put each of these strings back in its natural place, exactly as written here (not as a list at the end):\n- src/auth.ts\n- --fast`)
  expect(toasts).toEqual([])
  expect(events()).toMatchObject([{ outcome: 'rewritten', repaired: 'lost src/auth.ts' }])
  expect(events()[0].original).toBeUndefined()
})

test('when Opus does not answer, the prompt goes as typed and a toast says so', async ($, on) => {
  const { toasts, events } = engine(on, { reply: null })
  expect((await $.prompt.submit({ text: 'fix teh login bug', origin: ide, wait: false })).text).toBe('fix teh login bug')
  expect(toasts).toEqual(['Prompt sent as typed: Opus did not rewrite it (api-error)'])
  expect(events()).toMatchObject([{ outcome: 'failed' }])
})

test('the prompt goes in without waiting on the event write or a toast', async ($, on) => {
  const m = engine(on, { hang: true })
  const outcome = await Promise.race([
    $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false }).then(r => r.text),
    new Promise(done => setTimeout(() => done('held'), 500)),
  ])
  expect(outcome).toBe('Fix the login bug in `src/auth.ts`.')
  expect(m.events()).toMatchObject([{ outcome: 'rewritten' }])
})

test('a prompt Opus did not rewrite goes in without waiting on its toast', async ($, on) => {
  const failed = engine(on, { hang: true, reply: null })
  const typed = await Promise.race([
    $.prompt.submit({ text: 'fix teh login bug', origin: ide, wait: false }).then(r => r.text),
    new Promise(done => setTimeout(() => done('held'), 500)),
  ])
  expect(typed).toBe('fix teh login bug')
  expect(failed.toasts).toEqual(['Prompt sent as typed: Opus did not rewrite it (api-error)'])
})

test('the bench grades what Claude Code would receive for every prompt, by the judge it is given, and records the setup', async ($, on) => {
  const prompts = ['fix teh login bug in src/auth.ts', 'Run the unit tests and deploy.', 'send me teh login details please', 'yes']
  const { asked, written } = engine(on, { saved: JSON.stringify(prompts), replies: { 'Run the unit': '=', 'send me': null } })
  await $.command.run({ command: 'polish-bench', args: '/b/p.json - low claude-sonnet-5-5 claude-fable-5-1' } as Parameters<typeof $.command.run>[0])
  const rows = JSON.parse(written['/b/p.json.out.json'] ?? '[]') as { text: string; outcome: string; delivered?: string; grade?: object; model?: string; effort?: string; judge?: string }[]
  const by = Object.fromEntries(rows.map(r => [r.text, r]))
  // 2026-10-06: only rewrites were graded, so a model that left more prompts alone was graded on a different set of prompts
  expect(by['fix teh login bug in src/auth.ts']).toMatchObject({ outcome: 'rewritten', delivered: 'Fix the login bug in `src/auth.ts`.', grade: { fidelity: 3 } })
  expect(by['Run the unit tests and deploy.']).toMatchObject({ outcome: 'unchanged', delivered: 'Run the unit tests and deploy.', grade: { language: 4 } })
  expect(by['send me teh login details please']).toMatchObject({ outcome: 'failed', delivered: 'send me teh login details please', grade: { brevity: 5 } })
  expect(by['yes']).toMatchObject({ outcome: 'skipped' })
  expect(rows[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', judge: 'claude-fable-5-1' })
  const judged = asked.filter(a => a.system?.startsWith('You grade'))
  expect(judged.map(a => a.model)).toEqual(['claude-fable-5-1', 'claude-fable-5-1', 'claude-fable-5-1'])
  // Judge "-": a timing run, no grading load on the API while it measures
  await $.command.run({ command: 'polish-bench', args: '/b/p.json - low claude-sonnet-5-5 -' } as Parameters<typeof $.command.run>[0])
  expect(asked.filter(a => a.system?.startsWith('You grade'))).toHaveLength(3)
  const timed = JSON.parse(written['/b/p.json.out.json'] ?? '[]') as { text: string }[]
  expect(timed.find(r => r.text === 'Run the unit tests and deploy.')).toMatchObject({ outcome: 'unchanged', grade: null, judge: '-' })
})

test('instructions can put a reminder after the prompt, and a reply wrapped in <rewrite> tags is unwrapped', async ($, on) => {
  const { asked, written } = engine(on, {
    reply: '<rewrite>\nFix the login bug in `src/auth.ts`.\n</rewrite>',
    files: { '/b/p.json': JSON.stringify(['fix teh login bug in src/auth.ts']), '/b/sys.txt': 'Rewrite it.\n<<<AFTER>>>\nReply in <rewrite> tags.' },
  })
  await $.command.run({ command: 'polish-bench', args: '/b/p.json /b/sys.txt low claude-opus-5-5 -' } as Parameters<typeof $.command.run>[0])
  expect(JSON.parse(written['/b/p.json.out.json'] ?? '[]')[0]).toMatchObject({ outcome: 'rewritten', reply: 'Fix the login bug in `src/auth.ts`.' })
  expect(asked[0]).toMatchObject({ system: 'Rewrite it.', prompt: '<prompt>\nfix teh login bug in src/auth.ts\n</prompt>\n\nReply in <rewrite> tags.' })
})

// 2026-10-06 history: 6 prompts fail only some of the time (an empty reply or an API error); one retry may recover them
test('the bench can try a retry on a failed reply, given as an effort like low+retry', async ($, on) => {
  const prompt = 'tidy teh flaky prompt please'
  const { written } = engine(on, { files: { '/b/p.json': JSON.stringify([prompt]) }, replies: { flaky: [null, 'Tidy the flaky prompt.'] } })
  await $.command.run({ command: 'polish-bench', args: '/b/p.json - low+retry claude-opus-5-5 -' } as Parameters<typeof $.command.run>[0])
  expect(JSON.parse(written['/b/p.json.out.json'] ?? '[]')[0]).toMatchObject({ outcome: 'rewritten', reply: 'Tidy the flaky prompt.', effort: 'low', retries: 1 })
})

test('without a retry the same failure goes as typed', async ($, on) => {
  const { written } = engine(on, { files: { '/b/p.json': JSON.stringify(['tidy teh flaky prompt please']) }, replies: { flaky: [null, 'Tidy the flaky prompt.'] } })
  await $.command.run({ command: 'polish-bench', args: '/b/p.json - low claude-opus-5-5 -' } as Parameters<typeof $.command.run>[0])
  expect(JSON.parse(written['/b/p.json.out.json'] ?? '[]')[0]).toMatchObject({ outcome: 'failed' })
})

// 2026-10-06 final round: two blind judges, so neither one's taste decides
test('the bench can grade by several judges and averages them', async ($, on) => {
  const { written, asked } = engine(on, { files: { '/b/p.json': JSON.stringify(['fix teh login bug in src/auth.ts']) } })
  await $.command.run({ command: 'polish-bench', args: '/b/p.json - low claude-opus-5-5 claude-opus-5-5,claude-fable-5-1' } as Parameters<typeof $.command.run>[0])
  const row = JSON.parse(written['/b/p.json.out.json'] ?? '[]')[0]
  expect(row).toMatchObject({ judge: 'claude-opus-5-5,claude-fable-5-1', grade: { fidelity: 4, language: 4, claude_code: 4, brevity: 5 } })
  expect(Object.keys(row.grades)).toEqual(['claude-opus-5-5', 'claude-fable-5-1'])
  expect(asked.filter(a => a.system?.startsWith('You grade')).map(a => a.model)).toEqual(['claude-opus-5-5', 'claude-fable-5-1'])
})

// 2026-10-06 audit: a session keeps the mod it loaded until /reload-plugins, so a later fix never reached it, unseen
test('a session whose mod was saved again after it loaded says so once, as a toast', async ($, on) => {
  const files: Record<string, string> = { 'register.tsx': 'the source as loaded' }
  const { toasts } = engine(on, { files })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' } as never)
  await $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false })
  expect(toasts).toEqual([])
  files['register.tsx'] = 'the source saved later'
  await $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false })
  await $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false })
  expect(toasts).toEqual(['prompt-polish was updated after this session loaded it: run /reload-plugins to use the new version'])
})

test('a call with no answer by HEDGE_MS gets an identical second one, and the first answer goes in', async ($, on) => {
  const { asked, clock, events } = engine(on, { stall: 1 })
  let entered: string | undefined
  const sent = $.prompt.submit({ text: 'fix teh login bug in src/auth.ts', origin: ide, wait: false }).then(r => (entered = r.text))
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise<void>(r => setTimeout(() => r(), 5))
  }
  await until(() => asked.length > 0)
  expect(asked).toHaveLength(1)
  await clock.advance(HEDGE_MS)
  await until(() => entered !== undefined)
  expect(asked).toHaveLength(2)
  expect(asked[1]!.prompt).toBe(asked[0]!.prompt)
  expect(entered).toBe('Fix the login bug in `src/auth.ts`.')
  await sent
  await settle()
  expect(events()[0]).toMatchObject({ outcome: 'rewritten', hedged: 'won' })
})
