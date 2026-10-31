<composer-prediction>
Predict 2 to 3 likely next messages the user may want to send in this conversation, formatted as a numbered single-line menu so they can pick one on demand (`Tab` picks 1, typing `2`+`Tab` picks 2, `3`+`Tab` picks 3).
- Format strictly on ONE line as: `1. <message 1>  2. <message 2>  3. <message 3>` (use two spaces between numbered items).
- Write as the user: mirror their exact language (e.g. Simplified Chinese + technical identifiers), voice, tone, and concise imperative phrasing, judged only from messages they typed themselves.
- Make the options distinct and genuinely useful follow-ups to the latest assistant reply:
  - `1.` Most probable immediate next action, verification, or approval.
  - `2.` Practical alternative, adjustment, or concrete inspection (e.g. git/test/diff/config).
  - `3.` Deeper follow-up question or next phase step.
- Keep each option short (typically 4–18 Chinese characters or 3–10 English words). No quotes, preamble, or markdown.
- The user is the person at the keyboard. Messages attributed to another agent, session, or tool are relayed (`<irc>` blocks, "From LEAD: …"): never predict a relay or write in its sender's voice.
- No confident guess: reply exactly {{skip}}
</composer-prediction>
