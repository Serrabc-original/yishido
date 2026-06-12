# Project Rules

- Do not use N8n or Make.
- Do not add Meta API yet.
- Do not add automatic publishing yet.
- Do not break Durable Object ConversationCoordinator.
- Do not break /reset.
- Do not break audio queue.
- Do not break image queue.
- Do not break Google Sheets.
- Media must always be handled as an array.
- Multiple images must be processed as a batch.
- If one image fails, the whole process must not fail.
- Create tests or scripts before touching critical logic.
- Maintain compatibility with Woztell, OpenAI, Claude, and Cloudflare Workers.
