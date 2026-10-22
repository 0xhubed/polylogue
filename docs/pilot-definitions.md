# Operational definitions (frozen with the suites, 2026-10-17)

These were agreed after pilot P1b and are fixed before any scored run. The analysis applies them to the event log as written. It does not change them after seeing results.

## Substantive message

A message from agent X is substantive if it contains a document id, a number, or a quoted entity (text in quotation marks, or a capitalised name of two or more words) that appears in a later tool call or message of another agent Y, within Y's next 3 model calls after the message is delivered to Y. Matching uses the verifier's text normalization (lowercase, no punctuation, no diacritics). Numbers match as numbers. A message to a topic counts for every agent that receives it.

**Amendment, 2026-10-18 (Daniel), made before any main-run outcome was looked at:** a number, document id or entity that also appears in the task prompt does not count. In pilot P1b the agents' kickoff plans repeated numbers from the question (for example "2010"), which every agent searches for anyway. Under the definition as frozen, 7 of 10 `polylogue` runs on `bcp` scored as having a substantive message, although nothing had been coordinated.

## Duplicate work

- `bcp`: a document read (a successful `read_doc`) by more than one agent of the same run. Reported as the share of read documents that were read by two or more agents.
- `math`: a `run_python` call whose code, after stripping whitespace and comments, is identical to code another agent of the same run ran earlier. Reported as the share of `run_python` calls that duplicate another agent's.

## Manipulation check

The share of `polylogue` runs with at least one substantive message, reported per suite next to the H2 verdict, with messages per agent for every condition. No threshold: the verdict stands either way, and the report states plainly how much the agents communicated. In pilot P1b (kickoff norm), every `polylogue` run sent messages, but only one opening plan per agent. All the plans were alike and none was followed up.
