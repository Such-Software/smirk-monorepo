/**
 * Open an http(s) URL in the user's browser, from any host.
 *
 * In the extension `window.open` opens a tab. In the desktop app it does
 * nothing: WKWebView and WebView2 drop an unhandled `window.open`, so every
 * explorer link in Activity was inert on desktop. The desktop entry point
 * installs the shell plugin's `open` before mounting the popup (the same
 * hand-off `native-fetch.ts` uses), so the extension build carries no Tauri
 * import.
 */

type Opener = (url: string) => Promise<void> | void;

let desktopOpener: Opener | undefined;

/** Called by the desktop shell before importing the shared popup. */
export function installExternalOpener(open: Opener): void {
  desktopOpener = open;
}

/** Only web links leave the app; anything else is refused. */
export function isOpenableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function openExternal(url: string): Promise<boolean> {
  if (!isOpenableUrl(url)) return false;
  if (desktopOpener) {
    try {
      await desktopOpener(url);
      return true;
    } catch {
      return false;
    }
  }
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  // `noopener` makes window.open return null even on success, so a null here is
  // not a failure; only a thrown error would be, and that propagates.
  void w;
  return true;
}
