# What the ledger is

The ledger is a team's shared memory for coding agents: canonical metric **definitions**, **findings** from analyses, shipped **changes**, and **decisions** in force. One markdown file per object, in a git repo every teammate's agents read before work and write after.

It exists to kill four failures: two people getting different numbers for the same metric; redoing an analysis someone finished on Tuesday; crediting your test for someone else's fix; two agents compounding in opposite directions.

It is not a transcript archive and not a wiki. Analysis is the process; a finding is its durable output and carries its own inputs, method, assumptions, and reproduction recipe. Nothing else from a session belongs in it.

Objects are never edited. A refresh or reversal is a new object that supersedes the old one. Every object is owned by a human, never by an agent.
