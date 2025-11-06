### LCGPT — Local Context-Resettable GPT Chat

A tiny local web app to chat with OpenAI models while keeping conversations snappy. It lets you:
- Send only the current conversation context to the model (no hidden long-thread baggage)
- Instantly clear context with a button (now separates transcript vs. context)
- Create a brand-new conversation from scratch (keeps your prompts/settings)
- Save the whole conversation to disk on demand, plus automatic autosave every minute
- Properly renders assistant answers with Markdown (lists, tables, code blocks with syntax highlighting)
- Sticky header and left sidebar; only the chat area scrolls
- Hide/show the left sidebar with the top-left toggle (state persists)
- Set a system prompt per conversation and set a default system prompt used for new conversations
- Save/load/delete named system prompts to a local file (`prompts.json` beside the app), not the browser

#### Quick start
1. Install Node.js 18+.
2. In the project folder, create a `.env` file with your API key:
   ```env
   OPENAI_API_KEY=YOUR_KEY_HERE
   PORT=3000
   ```
3. Install dependencies and run:
   ```bash
   npm install
   npm start
   ```
4. Open http://localhost:3000 in your browser.

#### How it works
- The server is a tiny Express app (`index.js`) that serves the static UI from `public/` and exposes:
  - `POST /api/chat` → forwards your messages + optional system prompt to OpenAI and returns a reply.
  - `GET /api/prompts` → list saved prompts from `prompts.json`.
  - `POST /api/prompts` → save/update a prompt by name.
  - `DELETE /api/prompts/:name` → delete a saved prompt.
- Prompts are saved to `prompts.json` in the project directory so they persist across browsers and machines (as long as they share the folder).
- Conversations are ephemeral on the client side only. Use the “Clear context” button to instantly reset the history and send the next message with no previous messages.

#### UI tips
- Enter to send, Shift+Enter for newline
- Model selector in the left pane
- System prompt editor with Save by name; load/delete from Saved Prompts list
- Clear context button near the Send button

#### Models
The default model is `gpt-4o-mini`. You can also select: `gpt-4o`, `gpt-4.1-mini`, `gpt-4.1`, `o4-mini`, `o3-mini` from the Settings panel. You can change the default in the code if needed.

#### Notes & limits
- This app does not store full chat logs server-side; only the system prompts you intentionally save are written to disk.
- If you need streaming responses, function calling, or vision, those can be added later (the current version uses simple non-streaming chat completions for reliability).

#### Security
- Keep your `.env` private. The server runs locally and proxies your key; the browser never sees the key directly.
- Consider adding a simple password or binding to `127.0.0.1` only if you run on shared networks.

#### Files
- `index.js` — Express server + OpenAI proxy + prompt storage
- `public/index.html` — UI layout
- `public/style.css` — Styling
- `public/app.js` — Front-end logic and API calls
- `prompts.json` — Created automatically when first saving a prompt
- `.env` — Your local environment variables (not committed)

#### License
MIT
