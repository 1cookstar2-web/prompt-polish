# prompt-polish

A Claude Code mod. Each prompt you type is passed to Claude Opus 5.5 first. Opus fixes its spelling, punctuation and grammar, then makes it clear and direct, as Anthropic advises for prompting Claude Code. Claude Code gets the rewrite, with your exact words attached below it in case the rewrite lost something.

It doesn't add anything you didn't say. Code, commands, paths, URLs, error messages, quoted text and pasted blocks are copied exactly. A check runs on every rewrite. If the rewrite dropped one of those strings, added a preface, or grew too long, Opus gets one more try. If that also fails, your prompt is sent exactly as you typed it, and a toast tells you why.

Tested with Claude Code 2.1.292, in the terminal and the desktop app.

## Install

```
claude plugin marketplace add 1cookstar2-web/prompt-polish
claude plugin install prompt-polish@prompt-polish
```

Then run `/reload-plugins` in any open session.

## Use

Type as usual. These prompts are sent exactly as typed:

- A prompt that starts with `\`. The backslash is removed and the rest is sent unchanged.
- Slash commands, `!` shell lines, and replies shorter than four words, such as "yes do it".
- Prompts sent by scripts, the SDK, `claude -p`, or Remote Control from a phone.

To turn it off everywhere, set `PROMPT_POLISH_OFF=1`. To turn it off without uninstalling, run `claude plugin disable prompt-polish@prompt-polish`.

## Cost and speed

Every polished prompt is one Opus 5.5 call at low effort, and it counts toward your own Claude usage. A refused rewrite costs one more call. When a prompt needs no changes, Opus replies with a single character, so there's no wait for it to repeat the prompt. If a call hasn't answered after 6 s, the mod starts a second one and uses whichever answers first.

## Self-tuning and local data

After each prompt, `tune/tune.py` (Python 3, standard library only) reads the mod's recent results. When its rules call for it, it changes the effort level, the time limit or the minimum prompt length, and a toast says what changed. It keeps its data in `~/.local/state/prompt-polish/` (or `$PROMPT_POLISH_STATE`): one small JSON file per prompt with timings and the outcome, plus `tuning.json`. When a rewrite is refused, that prompt's file also holds your original prompt and the refused rewrite, so you can see what went wrong. Nothing is sent anywhere except the Opus call itself.

## Bench

`/polish-bench <prompts.json> [system.txt|-] [effort] [model] [judge]` runs a JSON list of prompts through the same rewrite and check, and writes `<prompts.json>.out.json`. A judge model grades each result for fidelity, language, Claude Code style and brevity; use `-` as the judge for a timing-only run.

## Develop

```
claude plugin validate .
claude plugin test .
python3 -m unittest discover -s tune
```

## License

MIT
