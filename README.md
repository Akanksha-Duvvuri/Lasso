# Snipsearch

Snip any part of your screen (or photograph a page), read it with a vision model, then copy the clean text, summarize it, ask about it, or search your library of everything you have snipped.

Works with **Google Gemini (free tier available, the default)** or **Anthropic Claude (paid)**. Pick one in Settings.

Two pieces:

- **Laptop app** (Electron, Windows / macOS / Linux): global hotkey, drag a region, clean text lands on your clipboard.
- **Phone app** (`mobile/`, installable web app): take a photo or pick a screenshot, same pipeline.

## 1. Laptop

Requires Node.js 20 or newer.

```bash
cd snipsearch
npm install
npm start
```

1. Get a free key at https://aistudio.google.com/apikey. In the panel, open **Settings**, keep the provider on Gemini, paste the key, press **Save settings**.
2. Press **Ctrl+Alt+X** (Cmd+Option+X on Mac) and drag over any text. The cleaned text is copied automatically.
3. **Ctrl+Alt+Z** shows or hides the panel. The tray icon does the same.
4. Drag an image file onto the panel to read it without snipping.

Hotkeys live in `settings.json` in the app's data folder (`snipHotkey`, `panelHotkey`) if they clash with another app.

Platform notes:

- **macOS**: allow Screen Recording for the app under System Settings > Privacy & Security, then restart it.
- **Linux**: works on X11. Wayland blocks silent screen capture, so use an X11 session.
- The panel is excluded from screen recordings where the OS supports it.

Build an installer: `npm run dist`.

## 2. Phone (no APK needed)

The `mobile/` folder is a static site. Host it over HTTPS, open the link on your phone, then use the browser menu > **Add to Home Screen**. It opens full screen like an app.

Fastest hosting: Cloudflare Pages > Create project > Direct upload > drag the `mobile` folder in. You get a free `*.pages.dev` link.

On the phone: Settings tab > paste your Gemini key > Read tab > Take photo or Choose image.

## 3. A real APK (optional)

Wrap the same `mobile/` folder with Capacitor. This needs Android Studio on your laptop.

```bash
mkdir snipsearch-android && cd snipsearch-android
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init Snipsearch com.yourname.snipsearch --web-dir ../snipsearch/mobile
npx cap add android
npx cap copy
npx cap open android
```

In Android Studio: Build > Build Bundle(s) / APK(s) > Build APK(s). Copy the APK to your phone and allow installs from unknown sources.

## How search works

- **Your library**: every snip is saved and searched locally (typo-tolerant, prefix matching) with MiniSearch on the laptop and a simple match on the phone.
- **The web**: tick **Search the web** when asking. With Gemini this uses Grounding with Google Search; with Claude it uses Anthropic's web search tool. Answers list their sources.

## Free tier, limits and privacy

- The Gemini free tier has rate limits that vary by model and account. See your active limits in Google AI Studio. If you hit one, the app says so; wait a minute and retry.
- Free-tier content can be used by Google to improve its products. Do not snip private or unpublished material on the free tier.
- Default models: `gemini-2.5-flash` and `claude-sonnet-5-5`. Change either in Settings if a model is retired or you want a newer one.
- Keys are stored encrypted by the OS on the laptop and in browser storage on the phone. That is fine for your own testing. A product for other people needs a small server (for example a Cloudflare Worker) that holds the key, authenticates users, and rate limits.
