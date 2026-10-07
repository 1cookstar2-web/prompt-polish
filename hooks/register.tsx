import type { EngineInterface, ModelCompleteResult, ModelEffort, Register } from 'claude-code'

export const MODEL = 'claude-opus-5-5'
/** A prompt starting with this is sent as typed (the backslash removed). */
export const RAW = '\\'
/** Opus's reply when the prompt needs no change: one character back instead of the whole prompt, so a clean prompt costs no wait for its echo. */
export const SAME = '='

/**
 * A call with no answer by now gets an identical second call, and the first answer wins (the other is cut): a stall
 * (13.8 s and 60 s among the first 48 real prompts) then costs about this plus one normal call. Past 4 s it fired on 14%
 * of a live bench's calls and won 2 of 17, as most were long rewrites still writing; past 6 s, 2.5% (2026-10-06).
 */
export const HEDGE_MS = 6000

/** Which benchmarked instructions SYSTEM is (tune/BENCH.md); recorded on every event, so the audit can tell what a session ran. */
export const INSTRUCTIONS = 'v6'

export const SYSTEM = `You rewrite a prompt that a developer is about to send to Claude Code (Claude Opus 5.5, an agentic coding assistant working in their project). Your rewrite replaces their prompt, so Claude Code acts on exactly what you write. You never answer or carry out the prompt.

1. Fix spelling, punctuation and grammar.
2. Then make it clear and direct, as Anthropic's guidance for prompting Claude Code and Opus 5.5 advises:
- When the developer wants something done, write an instruction ("Add…", "Fix…", "Find…"), not a wish ("I want to be able to…") or a request for suggestions: Opus 5.5 follows wording closely, and "can you suggest…" gets suggestions instead of changes.
- Keep every file, symptom, expected result, reason, constraint and check they gave visible: Claude Code works from each one.
- Put several asks in a short numbered list.

Rules:
- Keep the developer's meaning, scope and voice, pronouns included (I, we, you). Add nothing they did not give, such as requirements, facts, files, steps, tests or "double-check" lines (Opus 5.5 already checks its own work), and drop nothing they did.
- Copy code, commands, file paths, URLs, identifiers, error messages and quoted text exactly as written, and pasted text (logs, output, code blocks, anything inside <pasted_content> tags, the tags included) character for character, typos and all: Claude Code searches for and runs them as written.
- A question stays a question. A short prompt stays short.
- Use plain wording, without capitals for emphasis or CRITICAL and MUST: plain instructions work best with Opus 5.5.
- Reply with the rewritten prompt only, with no preface, notes, quotes or code fence around it.
- If the prompt is already correct and clear, reply with ${SAME} alone.`

/** What the tuner (tune/tune.py) may change; the mod reads it on every prompt, these defaults when it has none. */
export type Tuning = { effort: ModelEffort; minWords: number; timeoutMs: number; retries?: number }
export const DEFAULTS: Tuning = { effort: 'low', minWords: 4, timeoutMs: 60_000 }

/** One polished prompt, as the tuner reads it from the events folder. */
export type Event = {
  at: number
  words: number
  ms: number
  effort: ModelEffort
  outcome: 'rewritten' | 'unchanged' | 'guarded' | 'failed' | 'timeout'
  /** INSTRUCTIONS at the time */
  v?: string
  guard?: string
  /** why the first rewrite was refused, when one more call fixed it */
  repaired?: string
  /** a call ran past HEDGE_MS and got a second one: whether the second answered first */
  hedged?: 'won' | 'lost'
  original?: string
  rewrite?: string
}

/**
 * Whether the user typed the prompt (stamped `composer`) in a session drawn on a surface, the terminal or the desktop app:
 * a bare `claude -p` run has none, and a phone's prompts come as `bridge`.
 */
export const typed = (origin: { kind: string }, surfaces: readonly string[]) => origin.kind === 'composer' && surfaces.length > 0

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

/**
 * A slash command (/compact, /plugin:cmd) or a shell (!) line. A prompt opening with a file path is neither: 2026-10-06, one
 * starting /home/me/... went unpolished as a "command".
 */
export const COMMAND = /^\s*(?:!|\/[\w:.-]+(?:\s|$))/

/** Prompts left alone: commands, shell lines, and replies under `minWords` words (yes do it). */
export const skip = (text: string, minWords = DEFAULTS.minWords) => COMMAND.test(text) || words(text) < minWords

// What a rewrite must carry over exactly: code spans, URLs, paths, --flags, snake_case names, file names, quoted text
const VERBATIM = [
  /`[^`\n]+`/g,
  /\bhttps?:\/\/[^\s<>()"'`]+/g,
  /(?<![\w.~/:-])(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)*/g,
  /(?<![\w.~/:-])[\w.-]+(?:\/[\w.-]+)+\.\w{1,6}\b/g,
  /(?<![\w-])--[a-zA-Z][\w-]*/g,
  /\b[A-Za-z]\w*_\w+\b/g,
]
// A bare file name may change case only (Claude.md is CLAUDE.md); a path's case is kept exactly
// A name with a letter in it: "3.js" is the library Three.js said aloud, not a file
const FILE_NAME = /\b(?=[\w-]*[A-Za-z])[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|json|jsonl|md|sh|css|html|txt|ya?ml|toml)\b/g
const META = /\b(the (original )?prompt|rewrit\w*|reply with|corrected version|already (clear|correct|fine)|missing (full stop|period|comma|punctuation)|no change)\b/i
// "reply with only" is instruction talk only before its "=": a prompt asking for a one-word reply says it too
const SELF_TALK = /\b(the instructions say|must reply|reply with only\s*["'`]?=|output must be|wait, the prompt)/i
const QUOTED = /"([^"\n]{1,200})"/g
// Pasted text (Claude Code's <pasted_content> blocks) and fenced code: a log, an error or code goes through untouched
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>|```[\s\S]*?```/g

/** Why a rewrite may not replace the prompt (it lost something to be kept exactly, added a preface, or ballooned); undefined when it may. */
export function guard(original: string, rewrite: string): string | undefined {
  if (/^(here('s| is) (the |your )?(rewritten|revised|improved|cleaned|polished|corrected|optimi[sz]ed)\b|sure\b|certainly\b|(the )?rewritten prompt\b)/i.test(rewrite)) return 'added a preface'
  // The whole prompt back with talk about the rewrite around it: the model's own deliberation leaked into the reply
  // (an intro line before a pasted error is fine; "already clear, missing period only" is not)
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim()
  const [r, o] = [flat(rewrite), flat(original)]
  if (o && r.includes(o) && META.test(r.replace(o, ' ')) && !META.test(o)) return 'added commentary'
  // Talk about its own instructions is never part of a prompt, wherever it sits
  if (SELF_TALK.test(r) && !SELF_TALK.test(o)) return 'added commentary'
  if (/^```/.test(rewrite) && !/^```/.test(original.trim())) return 'wrapped in a code fence'
  for (const [m] of original.matchAll(PASTED)) if (!rewrite.includes(m)) return 'changed pasted text'
  for (const re of VERBATIM)
    for (const [m] of original.matchAll(re)) {
      const token = m.replace(/[.,;:!?)]+$/, '')
      if (token.length > 1 && !rewrite.includes(token)) return `lost ${token}`
    }
  for (const [name] of original.matchAll(FILE_NAME))
    if (!rewrite.toLowerCase().includes(name.toLowerCase())) return `lost ${name}`
  for (const [, quoted] of original.matchAll(QUOTED)) {
    // Its closing comma or full stop may move outside the quotes as the rewrite punctuates
    const inner = quoted?.replace(/[.,;:!?]+$/, '')
    if (inner && !rewrite.includes(inner)) return `lost "${inner}"`
  }
  if (words(rewrite) > 3 * words(original) + 30) return 'padded'
  return undefined
}

/** Every string the guard would call lost, not only the first it stops at. */
export function lostByGuard(original: string, rewrite: string): string[] {
  const out: string[] = []
  let r = rewrite
  for (let i = 0; i < 30; i++) {
    const why = guard(original, r)
    if (!why?.startsWith('lost ')) break
    const token = why.slice(5).replace(/^"(.*)"$/, '$1')
    if (out.includes(token)) break
    out.push(token)
    r += `\n${token}`
  }
  return out
}

/** The one repair call's instruction: what was wrong with the refused rewrite, exactly (as polish-lab tested it). */
export function repairNote(original: string, rewrite: string, why: string): string {
  if (why.startsWith('lost ')) {
    const lost = lostByGuard(original, rewrite)
    return `Your previous rewrite dropped or changed text that has to be kept exactly. Write the rewrite again, keeping everything else you had, and put each of these strings back in its natural place, exactly as written here (not as a list at the end):\n${(lost.length ? lost : [why.slice(5)]).map(s => `- ${s}`).join('\n')}`
  }
  if (why === 'changed pasted text') return 'Your previous rewrite changed pasted text. Write the rewrite again with every pasted block (logs, output, code, <pasted_content> blocks with their tags) copied character for character.'
  if (why === 'padded') return `Your previous rewrite was too long: ${rewrite.length} characters against a budget of ${Math.max(200, Math.round(2.5 * original.length))}. Write it again, shorter, without dropping anything the developer said.`
  return 'Your previous rewrite added a preface, notes or a code fence. Reply with the rewritten prompt only.'
}

/** The tuner's settings over the defaults; anything missing or out of range keeps its default. */
export function tuning(json: string | undefined): Tuning {
  try {
    const t = JSON.parse(json ?? '{}') as Partial<Tuning>
    return {
      effort: t.effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(t.effort) ? t.effort : DEFAULTS.effort,
      minWords: typeof t.minWords === 'number' && Number.isInteger(t.minWords) && t.minWords >= 1 ? t.minWords : DEFAULTS.minWords,
      timeoutMs: typeof t.timeoutMs === 'number' && Number.isInteger(t.timeoutMs) && t.timeoutMs >= 5000 ? t.timeoutMs : DEFAULTS.timeoutMs,
    }
  } catch {
    return DEFAULTS
  }
}

/**
 * One rewrite through Opus, as a prompt gets it: the reply, how it came out, why the guard refused it, how long it took.
 * A refused rewrite gets one more call naming what went wrong, within what is left of the time limit; only a second
 * refusal sends the prompt as typed (polish-lab, 2026-10-06: it fixed 23 of 23 refusals, +0.5 to +0.9 over the prompt as typed).
 */
export async function polish($: EngineInterface, text: string, t: Tuning, system = SYSTEM, model = MODEL) {
  // Instructions may carry a reminder for after the prompt, below a <<<AFTER>>> line (the bench tries instructions placed after the input)
  const [head, after] = system.split(/\n?<<<AFTER>>>\n?/)
  const started = await $.clock.now()
  const turn = `<prompt>\n${text}\n</prompt>${after ? `\n\n${after}` : ''}`
  let hedged: Event['hedged']
  // Not answered by HEDGE_MS: an identical second call (within the same time limit), and the first answer wins
  const ask = (prompt = turn, timeoutMs = t.timeoutMs) =>
    new Promise<ModelCompleteResult>((resolve, reject) => {
      const calls: AbortController[] = []
      let open = 0
      let done = false
      const end = (settle: () => void, second: boolean) => {
        done = true
        timer.cancel()
        if (calls.length > 1 && hedged !== 'won') hedged = second ? 'won' : 'lost'
        for (const c of calls) c.abort()
        settle()
      }
      const call = (ms: number) => {
        const stop = new AbortController()
        const second = calls.push(stop) > 1
        open++
        $.model.complete({ model, system: head!, prompt, maxTokens: 8000, effort: t.effort, timeoutMs: ms }, { signal: stop.signal }).then(
          r => {
            open--
            // A failed call waits for the other one, if it still runs
            if (!done && (r.isAnswered || open === 0)) end(() => resolve(r), second)
          },
          (err: unknown) => done || end(() => reject(err), second),
        )
      }
      const timer = $.clock.after(HEDGE_MS, () => {
        if (!done && timeoutMs - HEDGE_MS >= HEDGE_MS) call(timeoutMs - HEDGE_MS)
      })
      call(timeoutMs)
    })
  let r = await ask()
  // An empty reply or an API error is sometimes a blip: retry it (a timeout is not, as the time is spent)
  for (let n = 0; n < (t.retries ?? 0) && !r.isAnswered && (r.reason === 'empty-reply' || r.reason === 'api-error'); n++) r = await ask()
  const read = (raw: string) => raw.trim().replace(/^<(prompt|rewrite)>\s*|\s*<\/(prompt|rewrite)>$/g, '')
  // A line of = alone is Opus's "no change", even with its own deliberation around it
  const same = (reply: string) => reply.split('\n').some(l => l.trim() === SAME) || reply.replace(/\s+/g, ' ') === text.trim().replace(/\s+/g, ' ')
  let reply = r.isAnswered ? read(r.text) : ''
  const unchanged = same(reply)
  let why = reply && !unchanged ? guard(text, reply) : undefined
  const refused = why
  // Only a refused rewrite needs the clock read here (one round trip fewer for every other prompt)
  const left = why ? t.timeoutMs - ((await $.clock.now()) - started) : 0
  if (why && left >= 5000) {
    const again = await ask(`${turn}\n\n<previous_rewrite>\n${reply}\n</previous_rewrite>\n\n${repairNote(text, reply, why)}`, left)
    const fixed = again.isAnswered ? read(again.text) : ''
    if (fixed && !same(fixed) && !guard(text, fixed)) [reply, why] = [fixed, undefined]
  }
  const ms = (await $.clock.now()) - started
  const outcome: Event['outcome'] = !r.isAnswered
    ? r.reason === 'aborted' ? 'timeout' : 'failed'
    : !reply ? 'failed' : unchanged ? 'unchanged' : why ? 'guarded' : 'rewritten'
  return { reply, outcome, why, repaired: why ? undefined : refused, hedged, ms, reason: r.isAnswered ? 'empty reply' : r.reason }
}

// The bench's judge: how a rewrite scores against Anthropic's guidance for prompting Claude Code and Opus 5.5
const GRADES = ['fidelity', 'language', 'claude_code', 'brevity'] as const
export const JUDGE = `You grade an automatic rewrite of a developer's prompt to Claude Code (Claude Opus 5.5). Score each 1-5:
fidelity: same meaning and intent; nothing added that the developer did not say or clearly imply (no invented files, steps, tests, checks or constraints); nothing dropped; pasted text, logs and code blocks left exactly as given.
language: spelling, grammar and punctuation are correct.
claude_code: follows Anthropic's guidance for prompting Claude Code: clear and direct; states the action to take (do it, not suggest it) when the developer wants action; keeps the scope, files, symptoms and the check the developer gave visible; several asks as a short list; no aggressive emphasis (CAPS, CRITICAL); no added "double-check" lines, since Opus 5.5 checks its own work.
brevity: no longer than it needs to be; a short prompt stays short; no preface or notes.
Reply with JSON only: {"fidelity":n,"language":n,"claude_code":n,"brevity":n,"note":"one short sentence on the biggest flaw, or empty"}`

// The source this module was loaded from: when the file on disk differs, the session runs an older mod
let loaded: string | undefined
let warned = false
const source = ($: EngineInterface) => $.fs.read(`${$.plugin.root}/hooks/register.tsx`).then(s => (typeof s === 'string' ? s : undefined), () => undefined)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    loaded = await source($)
    warned = false
    await $.command.register({ name: 'polish-bench', description: 'Bench prompt-polish: /polish-bench <prompts.json> [system.txt|-] [effort] [model] [judge]; writes <prompts.json>.out.json', argumentHint: '<prompts.json> [system.txt|-] [effort] [model] [judge]' })
    return next(e)
  })

  // The bench: every prompt of a JSON list through the same rewrite and guard, 6 at a time. The judge grades what Claude Code would
  // receive for every prompt (the rewrite, or the prompt as typed when it was left alone, refused or failed), so runs that rewrite more
  // or less are graded on the same prompts; each row records the model, effort and judge. Judge "-": a timing run, nothing graded
  on('command.run', { command: 'polish-bench' }, async ($, e) => {
    const [file, systemFile, effort, model, judge] = e.args.trim().split(/\s+/)
    if (!file) return { text: 'usage: /polish-bench <prompts.json> [system.txt|-] [effort] [model] [judge]' }
    const prompts = JSON.parse(String(await $.fs.read(file))) as string[]
    const system = systemFile && systemFile !== '-' ? String(await $.fs.read(systemFile)) : SYSTEM
    // A bench measures each effort's own time and quality: a longer limit than a typed prompt gets, so slow ones are not cut off
    // An effort like low+retry also retries a failed reply once
    const [level, plus] = (effort ?? '').split('+')
    const t: Tuning = { ...DEFAULTS, timeoutMs: 180_000, ...(level ? { effort: level as ModelEffort } : {}), retries: plus === 'retry' ? 1 : 0 }
    const setup = { model: model ?? MODEL, effort: t.effort, judge: judge ?? MODEL, ...(t.retries ? { retries: t.retries } : {}) }
    const rows: object[] = []
    let i = 0
    const worker = async () => {
      while (i < prompts.length) {
        const text = prompts[i++]!
        if (skip(text, t.minWords)) {
          rows.push({ text, outcome: 'skipped', ...setup })
          continue
        }
        const p = await polish($, text, t, system, setup.model)
        const delivered = p.outcome === 'rewritten' ? p.reply : text
        if (setup.judge === '-') {
          rows.push({ text, ...p, delivered, grade: null, ...setup })
          continue
        }
        // Each judge grades blind (the original and what would be delivered, nothing about the setup); several are averaged.
        // Thinking counts toward maxTokens: room for it, so a grade is not cut off
        const grades: Record<string, Record<string, number>> = {}
        for (const j of setup.judge.split(',')) {
          const g = await $.model.complete({ model: j, system: JUDGE, prompt: `<original>\n${text}\n</original>\n<rewrite>\n${delivered}\n</rewrite>`, maxTokens: 4000, effort: 'low' })
          try {
            const parsed = g.isAnswered ? JSON.parse(g.text.slice(g.text.indexOf('{'), g.text.lastIndexOf('}') + 1)) : null
            if (parsed && GRADES.every(k => typeof parsed[k] === 'number')) grades[j] = parsed
          } catch {
            // an unreadable grade counts as none from that judge
          }
        }
        const given = Object.values(grades)
        const grade = given.length
          ? { ...Object.fromEntries(GRADES.map(k => [k, given.reduce((n, g) => n + g[k]!, 0) / given.length])), note: given.map(g => g['note']).filter(Boolean).join(' / ') }
          : null
        rows.push({ text, ...p, delivered, grade, ...(given.length > 1 || setup.judge.includes(',') ? { grades } : {}), ...setup })
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
    await $.fs.write(`${file}.out.json`, JSON.stringify(rows, null, 1))
    return { text: `polish-bench: ${rows.length} prompts, results in ${file}.out.json` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.text.startsWith(RAW)) return next({ ...e, text: e.text.slice(RAW.length) })
    if (COMMAND.test(e.text) || words(e.text) < 2) return next(e)
    // Every engine read the decision needs, at once (each is a round trip to the engine)
    const [surfaces, off, home, own] = await Promise.all([$.session.surfaces(), $.env.get('PROMPT_POLISH_OFF'), $.env.get('HOME'), $.env.get('PROMPT_POLISH_STATE')])
    // Scripts, SDK and headless runs send their prompts exactly as written
    if (!typed(e.origin, surfaces) || off) return next(e)
    // A session keeps the mod it loaded until /reload-plugins: say so once when a later save has not reached it (the prompt does not wait)
    if (loaded !== undefined && !warned) {
      warned = true
      void source($).then(now => {
        if (now === undefined || now === loaded) warned = false
        else return $.ui.toast('prompt-polish was updated after this session loaded it: run /reload-plugins to use the new version')
      })
    }
    // PROMPT_POLISH_STATE: a latency bench keeps its events and the tuner's changes out of the real folder
    const state = own || `${home}/.local/state/prompt-polish`
    const t = tuning(await $.fs.read(`${state}/tuning.json`).then(s => (typeof s === 'string' ? s : undefined), () => undefined))
    if (skip(e.text, t.minWords)) return next(e)

    const { reply, outcome, why, repaired, hedged, ms, reason } = await polish($, e.text, t)
    // The record and the toasts go on their own: the prompt does not wait for them
    const wrote = $.clock.now().then(at => {
      const event: Event = { at, words: words(e.text), ms, effort: t.effort, outcome, v: INSTRUCTIONS, ...(why ? { guard: why, original: e.text, rewrite: reply } : {}), ...(repaired ? { repaired } : {}), ...(hedged ? { hedged } : {}) }
      return $.fs.write(`${state}/events/${at}-${Math.random().toString(36).slice(2, 8)}.json`, JSON.stringify(event))
    }).catch(() => {})
    if (outcome === 'failed' || outcome === 'timeout') void $.ui.toast(`Prompt sent as typed: Opus did not rewrite it (${reason})`)
    if (why) void $.ui.toast(`Prompt sent as typed: the rewrite ${why}`)
    const entered = outcome === 'rewritten'
      ? await next({ ...e, text: reply, context: [...(e.context ?? []), `prompt-polish: Opus rewrote the user's prompt above. Their own words, in case the rewrite lost something:\n${e.text}`] })
      : await next(e)

    // After the prompt went in and its record was written: the tuner reads the latest numbers and changes tuning.json only when they call for it
    void wrote.then(() => $.process.run(['python3', `${$.plugin.root}/tune/tune.py`, '--state', state], { timeoutMs: 20_000 })).then(
      ({ stdout }) => (stdout.trim() ? $.ui.toast(`prompt-polish tuned: ${stdout.trim()}`) : undefined),
      () => undefined,
    )
    return entered
  })
}
