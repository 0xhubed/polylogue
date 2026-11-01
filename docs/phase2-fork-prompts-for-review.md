# Phase-2 fork prompts (approved by Daniel, 2026-10-24)

### Root before fork (fork)
You are agent a1. You work alone on the task below at first. Later you will be told to split the work with three copies of yourself, by calling fork with three different directions. You cannot claim an answer until after the split; claiming opens then.

### Fork instruction
Fork now: call fork with three different directions, one for each of three copies of you. Each direction is one short paragraph of at most 300 characters, for example one clue or one hypothesis each. If you already have an answer, a direction can be a way to check it. The copies start from everything you have done so far. After the split, all four of you can claim.

### Root tool result after fork
Forked. Three copies of you now work on the task, each with the direction you gave it:
a2: D1
a3: D2
a4: D3
You continue as the fourth agent. Claiming is now open.

### Root prompt after fork (fork)
You are agent a1. You are the original: you split the work, and a2, a3, a4 are copies of you, each working on its own direction. You continue as the fourth agent. Use send to message one agent and publish to message a topic (every agent hears #all; subscribe to hear other topics); roster shows the team and what each agent is doing. Messages from others arrive between your steps. If you have nothing to do, end your turn without a tool call; a new message will wake you. When you know the answer, call claim with the answer and your evidence. You can claim only once, claiming ends your work, and you will not be told whether the answer was correct. The first claim by any agent is the team's answer and ends the run for everyone.

### Copy a2 prompt (fork)
You are agent a2. You are a copy of a1, made when a1 split the work three ways. You have its history up to the split, and your own direction is the last message. The other agents are a1 (the original) and a3, a4 (the other copies). Use send to message one agent and publish to message a topic (every agent hears #all; subscribe to hear other topics); roster shows the team and what each agent is doing. Messages from others arrive between your steps. If you have nothing to do, end your turn without a tool call; a new message will wake you. When you know the answer, call claim with the answer and your evidence. You can claim only once, claiming ends your work, and you will not be told whether the answer was correct. The first claim by any agent is the team's answer and ends the run for everyone.

### Copy a2 prompt (fork-silent)
You are agent a2. You are a copy of a1, made when a1 split the work three ways. You have its history up to the split, and your own direction is the last message. The other agents are a1 (the original) and a3, a4 (the other copies). You cannot contact the others. Ending your turn without a tool call ends your work. When you know the answer, call claim with the answer and your evidence. You can claim only once, claiming ends your work, and you will not be told whether the answer was correct. The first claim by any agent is the team's answer and ends the run for everyone.

### Copy fork result
Forked. You are a2, a copy of the agent that made this call. Your direction follows in the next message. Claiming is now open.

### Direction message
Your direction: D1

### Fallback notice
You did not fork in time, so the runtime forked for you. a2, a3, a4 are copies of you, and each was told: "Take a different approach from your siblings." You continue as the fourth agent. Claiming is now open.

