# 🐾 PetGPT

## ✨ Introduction

PetGPT is a versatile, large-model-powered desktop pet application designed to bring AI companionship right to your desktop. It seamlessly integrates with various AI models (including 🤖 OpenAI and 🔮 Gemini), supports third-party endpoints, and is set to expand its capabilities with models like 🧠 Claude and local models via 🧱 Ollama. 

Beyond casual interaction, PetGPT offers:
- 🎨 Customizable character appearances  
- 😊 Dynamic facial expressions that reflect the tone of conversations  
- 🧩 Agent mode support for task-based AI companions  

---

## 🗂️ Table of Contents

- [🖼️ Screenshots](#-screenshots)  
- [🧭 User Interface Guide](#-user-interface-guide)  
- [🔧 Potential Installation Issues](#-potential-installation-issues)
- [🧑‍💻 Development Guide](#-development-guide)  
- [🧰 Tech Stack](#-tech-stack)  

---

## 🖼️ Screenshots

Here’s a glimpse of PetGPT in action:

![Chat with a Virtual Desktop Pet](https://i.imgur.com/dT7vRw7.png)  
*Interacting with your AI pet in real time*

![Add Chatbot Interface](https://i.imgur.com/JsS6G0W.png)  
*Create and customize new AI characters*

![Full Screen Interface with Chats History](https://i.imgur.com/Cc3pHik.png)  
*Full-screen view with history panel*

---

## 🧭 User Interface Guide

In the top-center toolbar, you will find three main buttons that help you control and manage your PetGPT experience:

![Toolbar Buttons](https://i.imgur.com/nAnXSr9.png)

1. 💬 **Conversation Button**  
   Toggle the chat window to start or continue conversations with your selected character.

2. ➕ **Add Chatbot Button**  
   Open the character creation panel where you can design a new AI companion, customize their appearance, and set up their personality.

3. 📋 **Select Chatbot Button**  
   Choose from your existing characters to switch personalities, models, or tasks quickly.

4. ⚙️ **System Settings Button**
   Open the system settings panel to set your default AI assistant, choose a conversation model, adjust the window size, and customize shortcut keys.

---

### 🪄 Show/Hide Shortcut

You can **show or hide PetGPT at any time** using the following keyboard shortcut:

⇧ Shift + Space ｜ Ctrl + Shift + Space (Or you can set them in settings page)

## 🧙‍♀️ Creating and Using a New Character

PetGPT allows you to create fully customizable characters powered by different AI models. Here's how to create and interact with your own unique chatbot companion.

---

### 1. Add a New Character

Click the ➕ **Add Chatbot** button from the top toolbar.

![Add Character Screen](https://i.imgur.com/JsS6G0W.png)

Fill in the fields:

- **Name**:  
  Set a unique name for your character (e.g., `JulesLiu`).

- **Personality Description**:  
  Describe your character in second‑person to shape their tone and behavior (e.g., “You are a witty storyteller who loves sci‑fi”).  
  > To use the system’s default prompt, leave this blank and keep **Use Default Personality** checked.

- **Character Image**:  
  Click **Choose Character Image** to upload your avatar, then click **Process Image** to convert it into the proper chat‑UI format.

#### 🖼️ Character Image Format

To enable expressive reactions during conversation, your image should follow this layout:

- **Dimensions**: `1024 × 1024` pixels  
- **Grid**: 2 × 2, containing four facial expressions:

  | Expression | Position     |
  |------------|--------------|
  | Neutral    | Top‑left     |
  | Happy      | Top‑right    |
  | Thinking   | Bottom‑left  |
  | Angry      | Bottom‑right |

  _Example:_  
  ![Expression Guide](https://i.imgur.com/LYliuT7.png)

- **Model Provider**:  
  Select one of the official API providers—**OpenAI**, **Grok**, **Gemini**—or choose **Others** to use:
  - A third‑party relay/proxy URL  
  - A locally running Ollama model instance

- **Model Name**:  
  Enter the model ID you wish to use (e.g., `gpt-4o`, `gemini-alpha`, or your local Ollama model name).

- **Model API Key**:  
  Paste your API key here if required by the provider.

- **Model URL**:  
  - **Default**: calls the official endpoint for your selected provider  
  - **Custom**: enter a proxy/relay URL or your Ollama host (e.g., `http://localhost:11434`)

- Click the green **Test API Key & Model** button to verify connectivity.

When everything passes, click **Save** to add your character to the list.

---

### 2. Select a Character

Click the 📋 **Select Chatbot** button from the top toolbar to view all your saved characters.

![Character Selection](https://i.imgur.com/OKuJFUz.png)

You can:

- Click **Select** to activate a character.
- Click **Delete** to remove a character.
- View a summary of each character’s personality and model settings.

---

### 3. Start Chatting!

![Chat With Chatbot](https://i.imgur.com/d5ZY2Yg.png)

At the top of the chat panel you’ll see a row of tabs—one for each active character session, plus a “+” button to open a new one. Click a character’s tab to switch into **that session and load all messages saved since this window was opened** (not your entire chat history).

Once a tab is selected:  
- The main area shows the character’s avatar and the conversation you’ve had in this session.  
- If available, quick‑reply suggestions will pop up in a “Quick reply” box just above the input field.

Below the chat window is your input area and a toolbar of buttons:

| Icon | Label   | Function                                                                 |
|------|---------|--------------------------------------------------------------------------|
| 🌐   | Agent   | Toggle **Agent mode** for system‑driven tasks or workflows               |
| 📄   | Memory  | Open the **Memory** for chat bot to read or save informations|
| 🔗   | Share   | Generate a shareable content to this conversation                           |
| 🔍   | Search  | Perform a web search from inside the chat                                |
| QT   | QT menu | Open the **Quick Tools** menu for quick reply                            |
| ➤   | Send    | Send your message (or press Enter)                                       |

Just type your message in the box at the bottom and hit Enter or click the send arrow. Your character will reply in their own style, complete with changing facial expressions and moods.  

Characters will respond in their own style, complete with facial expressions and moods based on their personality and tone.

---

### ✨ Tip: Show/Hide PetGPT Anytime

Use the following shortcut to quickly toggle the PetGPT interface:

⇧ Shift + Space ｜ Ctrl + Shift + Space (Or you can set them in settings page)

### 4. Fullscreen Mode & Conversation History

Click the ⬜ **Expand** button at the top of the chat window to enter fullscreen mode.

![Fullscreen Mode](https://i.imgur.com/Cc3pHik.png)

In fullscreen mode, you gain access to:

- 🕰️ **Conversation History**: All your past interactions are neatly listed on the left side, labeled by their latest message or topic. This allows you to quickly revisit earlier discussions.
- 📂 **Multi-Chat Management**: Easily switch between chats with different characters.
- 📌 **Persistent Memory**: Each conversation retains its own context, so your character remembers what’s been said in that specific session.

This makes PetGPT ideal for both quick one-off chats and long-running dialogues.

## 🔧 Potential Installation Issues

On **macOS**, if the installation fails due to extended‐attribute or permission errors, run:

```bash
sudo xattr -cr /path/to/petgpt.app
```

## 🧑‍💻 Development Guide

This section explains how to set up the development environment, run the app in development mode, and build it for production.

---

### 📁 Project Structure

The project has two main directories in the root:

```
.
├── electron     # Electron main process (desktop wrapper & backend)
├── frontend     # React-based frontend interface
```

Detailed structure:

```
electron/
├── assets/         # Character images, models, and static assets
├── dist/           # Compiled Electron build output
├── models/         # Model configuration and local model data
├── node_modules/
├── main.js         # Electron entry point
├── preload.js      # Context bridge for frontend-electron communication
├── package.json
├── yarn.lock

frontend/
├── dist/           # Compiled frontend output (used by Electron)
├── public/         # Public static files
├── src/
│   ├── assets/     # Static images, styles
│   ├── components/ # React components
│   ├── content/    # Page-level content or views
│   └── utils/      # Utility functions
├── node_modules/
├── package.json
└── yarn.lock
```

---

### 📦 Install Dependencies

Install dependencies in the following order:

```bash
# 1. Root dependencies
yarn install

# 2. Electron dependencies
cd electron
yarn install

# 3. Frontend dependencies
cd ../frontend
yarn install
```

---

### 🧪 Start in Development Mode

To run the application locally:

```bash
cd electron
yarn dev
```

This starts the Electron shell and loads the frontend from the `frontend/dist` directory.

> ⚠️ Make sure the frontend has been built at least once before running.

---

### 🏗️ Build for Production

From the root directory, build and package the app with:

```bash
yarn build     # Builds the frontend (React)
yarn dist      # Builds the Electron app for macOS (default)
```

#### 🪟 Windows Build

To build a Windows 64-bit executable:

```bash
yarn dist:win64
```

> 💡 Requires Windows or proper cross-platform setup with `wine` on macOS/Linux.

---

## 🧰 Tech Stack

PetGPT is built using a modern full-stack architecture that combines Electron and React, with powerful build tools and styling utilities to support a responsive and interactive AI experience.

### 🖥️ Desktop Shell: Electron

- [`electron`](https://www.electronjs.org/): Used as the cross-platform desktop app shell.
- [`electron-builder`](https://www.electron.build/): For packaging and building native installers for macOS and Windows.
- Custom `Preload.js` script to securely expose limited APIs to the frontend.

### 🌐 Frontend: React + Vite

- [`react`](https://react.dev/): UI rendering framework.
- [`vite`](https://vitejs.dev/): Fast frontend tooling and build system.
- [`react-router-dom`](https://reactrouter.com/): Client-side routing.
- [`react-markdown`](https://github.com/remarkjs/react-markdown) + [`remark-gfm`](https://github.com/remarkjs/remark-gfm): For rendering chat messages with Markdown and GitHub-flavored markdown support.
- [`highlight.js`](https://highlightjs.org/): Code block syntax highlighting.
- [`zod`](https://zod.dev/): Schema validation.
- [`openai`](https://www.npmjs.com/package/openai): OpenAI API client for interacting with GPT models.

### 🎨 Styling

- [`tailwindcss`](https://tailwindcss.com/): Utility-first CSS framework.
- [`@tailwindcss/vite`](https://tailwindcss.com/docs/guides/vite): Tailwind integration with Vite.
- [`motion`](https://motion.dev/): Animation library used for chat transitions and UI interactions.

### 📦 Tooling & Dev Utilities

- [`dotenv`](https://www.npmjs.com/package/dotenv): Environment variable management.
- [`eslint`](https://eslint.org/): Linting for consistent code quality.
- [`concurrently`](https://www.npmjs.com/package/concurrently): For running multiple processes in parallel.
- [`wait-on`](https://www.npmjs.com/package/wait-on): For syncing frontend/backend build steps.
- [`canvas`](https://www.npmjs.com/package/canvas): Image rendering and manipulation.

---

> 🧠 Note: The project is modular and can support additional AI providers (e.g. Gemini, Claude, Ollama) via configurable model backends.