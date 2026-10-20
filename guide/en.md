# How to download everything from Yandex Disk

A simple guide. It takes about five minutes.

*Translated from Russian. Corrections are welcome on [GitHub](https://github.com/verhogladov/yandex-disk-download-all/issues).*

**What happened.** Since 11 October 2026 the Yandex Disk website no longer lets you download a folder, several files or the whole Disk at once — only one file at a time. The free browser extension “Download All from Yandex Disk” brings the “Download” button back: it downloads the files one by one and puts them into the same folders as on the Disk.

**You will need:**

- a computer or laptop (Windows, macOS or Linux);
- Google Chrome or Yandex Browser (Edge, Opera, Brave and Vivaldi work too);
- free space on the computer — roughly as much as your Disk uses.

It does not work on phones: mobile browsers cannot install this kind of extension. You need a computer.

## Step 1. Download the extension

1. Click: **[download yandex-disk-download-all.zip](https://github.com/verhogladov/yandex-disk-download-all/releases/latest/download/yandex-disk-download-all.zip)**. The file goes to your Downloads folder.
2. Unzip it:
   - **Windows:** right-click the file → “Extract All…” → “Extract”;
   - **macOS:** double-click the file.
3. You get a folder called `yandex-disk-download-all`. Move it somewhere it won't be in the way, for example to Documents. Don't delete it later: the browser loads the extension from this folder.

## Step 2. Install the extension in the browser

**Google Chrome**

1. Paste `chrome://extensions` into the address bar and press Enter.
2. In the top right corner, turn on **Developer mode**.
3. In the top left corner, click **Load unpacked**.
4. Choose the `yandex-disk-download-all` folder (the one that contains the `manifest.json` file).
5. “Download All from Yandex Disk” appears in the list. Done.

**Yandex Browser** — the same, just use the address `browser://extensions`.

**Edge, Opera, Brave, Vivaldi** — use `edge://extensions`, `opera://extensions`, `brave://extensions` or `vivaldi://extensions`, then the same: Developer mode → Load unpacked.

> Developer mode is normal: this is how extensions from outside the store are installed. The extension is free and its code is open. If the browser offers to disable such extensions at startup, decline.

## Step 3. Turn off the “where to save” question

Otherwise the browser will ask about every file, and there may be thousands of them.

- **Chrome:** open `chrome://settings/downloads` and turn off **Ask where to save each file before downloading**.
- **Yandex Browser:** Settings → Tools → Downloaded files → untick **Always ask where to save files**.
- **Other browsers:** in the downloads section of the settings, turn off the question about where to save each file.

## Step 4. Download your files

1. Open [disk.yandex.ru](https://disk.yandex.ru) and sign in. If the Disk was already open, reload the page (F5).
2. A blue **Download whole Disk** button appears in the bottom right corner. Inside a folder it says “Download folder”, and if you select files — “Download selected”.
3. Click it. A window opens:
   - **What to download** — the whole Disk, this folder, the selection, or “Pick files and folders…” from a list;
   - **Which files** — all of them or “Only the types I need” (for example, only photos and videos);
   - **Where to save** — to the computer as files in the same folders as on the Disk, as one ZIP archive, or to another cloud.
4. Click **Start downloading** and wait. The window shows how much is done.

![The extension window](../docs/setup.png)

*The screenshot shows the Russian interface. The language is chosen in the top line of the window: there are 23 languages.*

**While it downloads**, you can minimize the Disk tab, but **don't close** it. If the tab was closed or the computer turned off, open the Disk again and click “Continue”. Files that are already downloaded are not downloaded again.

**Where the files are:** Downloads → Yandex Disk, in the same folders as on the Disk.

## If something went wrong

| What you see | What to do |
| --- | --- |
| No blue button | Reload the Disk page (F5). Check in `chrome://extensions` that the extension is turned on. |
| The browser asks where to save every file | Do step 3, then click “Continue”. |
| Some files say “Failed” | Yandex servers don't return everything right now. Click “Retry failed” in an hour or two. The “Report (CSV)” button saves the list of such files. |
| Not enough space on the computer | Choose the ZIP archive in parts, a transfer to another cloud, or set an external drive as the download folder in the browser settings. |
| “Yandex asks you to pass the ‘I'm not a robot’ check” | Click “Pass the check”, prove you are not a robot, then click “Continue”. |
| A photo name contains “(preview)” | The original wasn't available, so a smaller copy was saved. Later click “Try the originals again instead of previews”. |

## Is it safe?

- The extension works only on the Yandex Disk website and only in your browser. It never asks for your Yandex password. Your files go nowhere except a cloud you connect yourself.
- It is not a Yandex program but an independent free open-source project.

## How to remove or update it

- **Remove:** `chrome://extensions` → “Remove” on the extension. Downloaded files stay.
- **Update:** download the archive again (step 1), unzip it over the old folder replacing the files, then click the round arrow on the extension in `chrome://extensions`.

## Need help?

Write on the [project's issues page](https://github.com/verhogladov/yandex-disk-download-all/issues) (a free GitHub account is needed). Describe what you did and what you saw; a screenshot helps a lot.
